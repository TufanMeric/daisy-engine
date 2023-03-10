import {
  ClientProtocol,
  NumberRef,
  ServerProtocol,
} from '@daisy-engine/common';
import { MessageHandler } from './MessageHandler';
import { Networking } from './Networking';

export class Room {
  private _id!: string;
  private _sendBuffer: Buffer;
  private _closeReason: string | undefined;
  private _localClientId: number = -1;
  private _pingTimeout: NodeJS.Timer | undefined;
  private _lastPingTimestamp: number = Number.MAX_VALUE;
  private _latencySamples: number[] = [];
  /**
   * The number of samples to use when calculating average latency.
   * @default 10
   * @type {number}
   */
  latencySampleSize: number = 10;
  // pingDelay is the time between pings in milliseconds
  pingDelay: number | undefined = 5000;

  get currentLatency(): number {
    return this._latencySamples[this._latencySamples.length - 1];
  }
  get averageLatency(): number {
    return (
      this._latencySamples.reduce((a, b) => a + b, 0) /
      this._latencySamples.length
    );
  }

  get localClientId(): number {
    return this._localClientId;
  }

  get closeReason(): string | undefined {
    return this._closeReason;
  }

  get id(): string {
    return this._id;
  }

  private _net: Networking;
  private _connectResultCallback?: (error?: string) => void;
  private _messageHandlers: Map<string | number, MessageHandler>;
  private _closeCallbacks: Set<(e: Event) => void>;
  private _serverErrorCallbacks: Set<(error: string) => void>;

  constructor() {
    this._net = new Networking();
    this._messageHandlers = new Map();
    this._closeCallbacks = new Set();
    this._serverErrorCallbacks = new Set();

    // Pre-allocate 16MB buffer for sending data
    this._sendBuffer = Buffer.alloc(16 * 1024 * 1024);
  }

  /**
   * Registers a handler for `event`
   * @param event Unique identifier for this event.
   *
   * Using a `string` for event ids is not recommended as it makes the network
   * packet considerably bigger (2 bytes for length and an extra 2 bytes for
   * every character in string).
   *
   * You may use any number from 0 to 255.
   * @param handler The {@link MessageHandler} function that will be called when
   * this event is received.
   */
  onMessage(event: string | number, handler: MessageHandler) {
    if (typeof event === 'number' && (event > 255 || event < 0))
      throw new Error('When using numbers, Event ID must be in range 0-255!');

    this._messageHandlers.set(event, handler);
  }

  onClose(callback: (e: Event) => void) {
    this._closeCallbacks.add(callback);
  }

  onError(callback: (error: string) => void) {
    this._serverErrorCallbacks.add(callback);
  }

  send(event: string | number, message: Buffer | string) {
    this._net.send(this._packMessage(event, message));
  }

  async _internalConnect(serverAddr: string, packet: Buffer) {
    // Set callbacks
    this._net.onOpen = this._onOpen.bind(this);
    this._net.onClose = this._onClose.bind(this);
    this._net.onMessage = this._onMessage.bind(this);

    // Wait for connection
    return new Promise<void>(async (resolve, reject) => {
      this._connectResultCallback = (error) => {
        if (error) return reject(error);

        resolve();
      };

      // Wait for connection
      await this._net.connectAsync(serverAddr);

      // Send init packet
      this._net.send(packet);

      // Start pinging
      this._ping();
    });
  }

  private _ping() {
    // Clear previous timeout
    clearTimeout(this._pingTimeout!);

    // Send ping
    this._lastPingTimestamp = Date.now();
    this._net.send(Buffer.from([ClientProtocol.Ping]));
  }

  private _onOpen(e: Event) {
    //console.log('[Room] Connected to server %s', this._addr);
  }

  private _onClose(e: Event) {
    //console.log('[Room] Disconnected from server', e);
    clearInterval(this._pingTimeout!);
    for (const callback of this._closeCallbacks) {
      callback.call(undefined, e);
    }
  }

  private _onMessage(buf: Buffer) {
    const ref: NumberRef = { value: 0 };

    const packetId = <ServerProtocol>buf[ref.value++];

    switch (packetId) {
      case ServerProtocol.Ping:
        // Calculate latency
        const latency = Date.now() - this._lastPingTimestamp;
        // Add new sample
        this._latencySamples.push(latency);
        // Remove oldest sample if we have more than latencySampleSize samples
        if (this._latencySamples.length > this.latencySampleSize) {
          this._latencySamples.shift();
        }
        // Set timeout for next ping
        this._pingTimeout = setTimeout(() => this._ping(), this.pingDelay);
        break;
      case ServerProtocol.UserPacket:
        this._onUserMessage(buf, ref);
        break;
      case ServerProtocol.RoomInfo:
        // Read room id
        const idLen = buf.readUInt16LE(ref.value);
        ref.value += 2;
        // Read room id, each character is 2 bytes
        this._id = buf.toString('utf16le', ref.value, ref.value + idLen * 2);
        ref.value += idLen * 2;

        // Invoke callbacks
        if (this._connectResultCallback) {
          this._connectResultCallback?.call(undefined);
        }

        break;
      case ServerProtocol.ClientId:
        this._localClientId = buf.readUInt32LE(ref.value);
        ref.value += 4;
        break;
      case ServerProtocol.Error:
        // Read error message
        const errorLen = buf.readUInt16LE(ref.value);
        ref.value += 2;
        const error = buf.toString(
          'utf16le',
          ref.value,
          ref.value + errorLen * 2
        );
        ref.value += errorLen * 2;

        // Log error
        console.error('[SERVER ERROR]', error);

        // Invoke callbacks
        if (this._connectResultCallback) {
          this._connectResultCallback?.call(undefined, error);
        }
        for (const callback of this._serverErrorCallbacks) {
          callback.call(undefined, error);
        }

        break;
      case ServerProtocol.CloseReason:
        // Read close reason
        const reasonLen = buf.readUInt16LE(ref.value);
        ref.value += 2;
        const reason = buf.toString(
          'utf16le',
          ref.value,
          ref.value + reasonLen * 2
        );
        ref.value += reasonLen * 2;

        // Log close reason
        console.log('[CLOSE REASON]', reason);

        // Invoke callbacks
        if (this._connectResultCallback) {
          this._connectResultCallback?.call(undefined, reason);
        }

        // Save close reason
        this._closeReason = reason;

        break;
      default:
        break;
    }
  }

  private _onUserMessage(buf: Buffer, ref: NumberRef) {
    const eventType = buf[ref.value++];

    switch (eventType) {
      case 0: {
        // Number event
        const event = buf.readUInt8(ref.value++);

        // Invoke handler
        this._messageHandlers
          .get(event)
          ?.call(this, this._getUserMessageContent(buf, ref));
        break;
      }
      case 1: {
        // String event
        const eventLen = buf.readUInt16LE(ref.value);
        ref.value += 2;
        const event = buf.toString(
          'utf16le',
          ref.value,
          ref.value + eventLen * 2
        );
        ref.value += eventLen * 2;

        // Invoke handler
        this._messageHandlers
          .get(event)
          ?.call(this, this._getUserMessageContent(buf, ref));

        break;
      }
    }
  }

  /**
   * Magically reads `data` of a message from a `Buffer`
   * @internal
   */
  private _getUserMessageContent(buf: Buffer, ref: NumberRef) {
    const dataType = buf[ref.value++];

    switch (dataType) {
      case 0:
        // Buffer data
        return buf.subarray(ref.value);
      case 1:
        // String data
        const dataLen = buf.readUInt16LE(ref.value);
        ref.value += 2;
        const data = buf.toString(
          'utf16le',
          ref.value,
          ref.value + dataLen * 2
        );
        ref.value += dataLen * 2;

        return data;
      default:
        throw new Error(`Invalid dataType for message: ${dataType}`);
    }
  }

  /**
   * Magically turns event and data into a `Buffer` that the server will
   * understand.
   * @internal
   */
  private _packMessage<T = string | number, T2 = Buffer | string>(
    event: T,
    data: T2
  ) {
    let ref: NumberRef = { value: 0 };
    this._sendBuffer.writeUInt8(ClientProtocol.UserPacket, ref.value++);

    if (typeof event === 'number') {
      // Event is uint8
      this._sendBuffer.writeUInt8(0, ref.value++);
      this._sendBuffer.writeUInt8(event, ref.value++);
    } else if (typeof event === 'string') {
      // Event is string
      this._sendBuffer.writeUInt8(1, ref.value++);
      this._sendBuffer.writeUInt16LE(event.length, ref.value);
      ref.value += 2;
      ref.value += this._sendBuffer.write(event, ref.value, 'utf16le');
    }

    if (data instanceof Buffer) {
      // Data is buffer
      this._sendBuffer.writeUInt8(0, ref.value++);
      ref.value += data.copy(this._sendBuffer, ref.value, 0);
    } else if (typeof data == 'string') {
      // Data is string
      this._sendBuffer.writeUInt8(1, ref.value++);
      this._sendBuffer.writeUInt16LE(data.length, ref.value);
      ref.value += 2;
      ref.value += this._sendBuffer.write(data, ref.value, 'utf16le');
    }

    return this._sendBuffer.subarray(0, ref.value);
  }
}
