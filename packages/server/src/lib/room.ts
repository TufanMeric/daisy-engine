import { NetworkClient } from './NetworkClient';
import { ClientStatus } from './ClientStatus';
import { NumberRef, ServerProtocol } from '@daisy-engine/common';

// Pre-allocate 16MB buffer for sending data
const BUFFER_SIZE = 16 * 1024 * 1024;
const BUFFER = Buffer.alloc(BUFFER_SIZE);
type MessageHandler = (client: NetworkClient, message: Buffer | string) => void;

export class Room {
  /** Unique ID of this room */
  readonly id: string;

  /**
   * Number of clients that may connect to this room.
   * @default Infinity
   */
  maxClients: number = Infinity;

  /**
   * A map of clients.
   * Key is the {@link NetworkClient.id}.
   */
  clients: Map<number, NetworkClient>;

  private _messageHandlers: Map<string | number, MessageHandler>;

  private _tickNumber: number;
  private _lastTime: number;
  private _accumulator: number;
  private _deltaTimeMs: number;
  private _maxAccumulation: number = 25;
  private _stopTicking: boolean;
  private _disableBuiltinTicker: boolean;

  /**
   * Current tick number.
   * Increased by 1 every time tick() gets called.
   */
  get tickNumber(): number {
    return this._tickNumber;
  }
  /**
   * Current accumulated frame time, in milliseconds.
   */
  get accumulator(): number {
    return this._accumulator;
  }
  /**
   * Fixed time between ticks, in seconds.
   */
  get deltaTime(): number {
    return this._deltaTimeMs / 1000;
  }
  /**
   * Fixed time between ticks, in milliseconds.
   */
  get deltaTimeMs(): number {
    return this._deltaTimeMs;
  }

  constructor(id: string, opts?: any) {
    this.id = id;

    this.clients = new Map();
    this._messageHandlers = new Map();

    this._tickNumber = 0;

    this.init(opts);
    this._postInit();
  }

  /**
   * Called when this room is ready to be initialized.
   */
  protected init(opts?: any) {}

  /**
   * Called every {@link deltaTime} milliseconds.
   */
  protected tick() {}

  /**
   * How many times should {@link tick} be called?
   *
   * Set to 0 if you want to disable the built-in ticker.
   * @param ticksPerSecond Number of ticks per second.
   */
  setTickRate(ticksPerSecond: number) {
    if (ticksPerSecond <= 0) this._disableBuiltinTicker = true;
    this._deltaTimeMs = 1000 / ticksPerSecond;
  }

  /**
   * Sets the maximum number of milliseconds that can be accumulated in one
   * frame.
   * @param maxAccumulation Maximum number of milliseconds that can be
   * accumulated.
   */
  setMaxAccumulation(maxAccumulation: number) {
    this._maxAccumulation = maxAccumulation;
  }

  /**
   * Called before this room is closed.
   */
  cleanup() {}

  /**
   * Authenticates the client. If this method throws an exception,
   * authentication will fail with exception message.
   * @param client Client to authenticate
   * @param authString The authentication string passed from client
   */
  onClientAuth(client: NetworkClient, authString: string) {}

  /**
   * Called when a client joins the room
   * @param client
   */
  onClientJoined(client: NetworkClient) {}

  /**
   * Called when a client leaves the room
   * @param client
   */
  onClientLeft(client: NetworkClient) {}

  /**
   * Checks if this room is full.
   * You might override this method to account for
   * seats reserved by whatever matchmaker you're using.
   * @returns `true` if room is full
   */
  isFull() {
    return this.clients.size >= this.maxClients;
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

    this._messageHandlers[event] = handler;
  }

  /**
   * Sends a message to a specific client
   * @param client {@link NetworkClient} that will receive the message
   * @param event Unique identifier for this event. See {@link onMessage}
   * for more info about event identifiers.
   * @param data Data that will be sent to this client.
   */
  send<T = string | number, T2 = Buffer | string>(
    client: NetworkClient,
    event: T,
    data: T2
  ) {
    if (client.status !== ClientStatus.JOINED) return;
    client._internalSend(this._packMessage(event, data));
  }

  /**
   * Sends a message to everyone in this room.
   * @param event Unique identifier for this event. See {@link onMessage}
   * for more info about event identifiers.
   * @param data Data that will be broadcasted.
   */
  broadcast<T = string | number, T2 = Buffer | string>(event: T, data: T2) {
    const msg = this._packMessage(event, data);
    this._broadcast(msg);
  }

  /**
   * Called before this room is closed.
   * @internal
   */
  _internalCleanup() {
    this.cleanup();
  }

  /**
   * Handles connections.
   * @internal
   */
  _internalOnOpen(client: NetworkClient) {
    this._sendClientId(client);
    this._sendRoomInfo(client);
    this.clients.set(client.id, client);

    //console.log(`Client ${client.id} connected`);

    this.onClientJoined(client);
  }

  /**
   * Handles disconnects.
   * @internal
   */
  _internalOnClose(client: NetworkClient, code: number, reason: Buffer) {
    this.clients.delete(client.id);

    //console.log(`Client ${client.id} disconnected (Code ${code})`);

    this.onClientLeft(client);
  }

  /**
   * Magically turns a `Buffer` into a message that's easier to work with.
   * @internal
   */
  _internalOnUserMessage(client: NetworkClient, buf: Buffer, ref: NumberRef) {
    const eventType = buf.readUInt8(ref.value++);

    switch (eventType) {
      case 0: {
        // Number event
        const event = buf.readUInt8(ref.value++);

        this._messageHandlers[event]?.call(
          this,
          client,
          this._getUserMessageContent(buf, ref)
        );
        break;
      }
      case 1: {
        // String event
        const eventLength = buf.readUInt16LE(ref.value);
        ref.value += 2;
        const event = buf.toString(
          'utf16le',
          ref.value,
          ref.value + eventLength * 2
        );
        ref.value += eventLength * 2;

        this._messageHandlers[event]?.call(
          this,
          client,
          this._getUserMessageContent(buf, ref)
        );

        break;
      }
    }
  }

  /**
   * Runs after {@link init}
   */
  private _postInit() {
    if (!this._disableBuiltinTicker) {
      this._lastTime = this._now();
      this._accumulator = 0;

      this._stopTicking = false;
      this._tick();
    }
  }

  /**
   * @returns High resolution timestamp if available
   */
  private _now() {
    if (performance !== undefined) {
      return performance.now();
    }
    if (window !== undefined) {
      if (window.performance.now) {
        return window.performance.now();
      } else {
        return Date.now();
      }
    }
  }

  /**
   * Built-in ticker.
   *
   * See {@link https://gafferongames.com/post/fix_your_timestep/} for more
   * info.
   */
  private _tick() {
    const newTime = this._now();
    const frameTime = Math.min(this._maxAccumulation, newTime - this._lastTime);

    this._lastTime = newTime;
    this._accumulator += frameTime;

    while (this._accumulator >= this._deltaTimeMs) {
      if (this._stopTicking || this._disableBuiltinTicker) return;

      this.tick();

      this._accumulator -= this._deltaTimeMs;
      this._tickNumber++;
    }

    setImmediate(() => this._tick());
  }

  /**
   * Magically reads `data` of a message from a `Buffer`
   * @internal
   */
  private _getUserMessageContent(buf: Buffer, ref: NumberRef) {
    const dataType = buf.readUInt8(ref.value++);

    switch (dataType) {
      case 0:
        // Buffer data
        return buf.subarray(ref.value);
      case 1:
        // String data
        const dataLength = buf.readUInt16LE(ref.value);
        ref.value += 2;
        const data = buf.toString(
          'utf16le',
          ref.value,
          ref.value + dataLength * 2
        );
        ref.value += dataLength * 2;
        return data;
      default:
        throw new Error(`Invalid dataType for message: ${dataType}`);
    }
  }

  /**
   * Magically turns event and data into a `Buffer` that the client will
   * understand.
   * @internal
   */
  private _packMessage<T = string | number, T2 = Buffer | string>(
    event: T,
    data: T2
  ) {
    let ref: NumberRef = { value: 0 };
    //serializeUInt8(ServerProtocol.UserPacket, BUFFER, ref);
    BUFFER.writeUInt8(ServerProtocol.UserPacket, ref.value++);
    if (typeof event === 'number') {
      // Event is uint8
      BUFFER.writeUInt8(0, ref.value++);
      BUFFER.writeUInt8(event, ref.value++);
    } else if (typeof event === 'string') {
      // Event is string
      BUFFER.writeUInt8(1, ref.value++);
      BUFFER.writeUInt16LE(event.length, ref.value);
      ref.value += 2;
      ref.value += BUFFER.write(event, ref.value, 'utf16le');
    }

    if (data instanceof Buffer) {
      // Data is buffer
      BUFFER.writeUInt8(0, ref.value++);
      ref.value += data.copy(BUFFER, ref.value, 0);
    } else if (typeof data == 'string') {
      // Data is string
      BUFFER.writeUInt8(1, ref.value++);
      BUFFER.writeUInt16LE(data.length, ref.value);
      ref.value += 2;
      ref.value += BUFFER.write(data, ref.value, 'utf16le');
    }

    return BUFFER.subarray(0, ref.value);
  }

  /**
   * Sends a client its ID.
   * @param client
   */
  private _sendClientId(client: NetworkClient) {
    let offset = 0;

    BUFFER.writeUInt8(ServerProtocol.ClientId, offset++);
    BUFFER.writeUInt32LE(client.id, offset);
    offset += 4;

    client._internalSend(BUFFER.subarray(0, offset));
  }

  /**
   * Sends room info to specified `client`
   * @param client
   * @internal
   */
  private _sendRoomInfo(client: NetworkClient) {
    let offset = 0;

    BUFFER.writeUInt8(ServerProtocol.RoomInfo, offset++);
    // Write room id string
    BUFFER.writeUInt16LE(this.id.length, offset);
    offset += 2;
    offset += BUFFER.write(this.id, offset, 'utf16le');

    client._internalSend(BUFFER.subarray(0, offset));
  }

  private _broadcast(msg: Buffer) {
    for (const [_, client] of this.clients) {
      if (client.status !== ClientStatus.JOINED) continue;
      client._internalSend(msg);
    }
  }
}
