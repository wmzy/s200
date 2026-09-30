/**
 * Bun-side WebSocket round trip for ws-chat — spawned by smoke.ts as
 * `bun smoke-ws.ts <base-url>` (bun ships a native WebSocket client; node
 * would need a dependency for one, and this example stays dep-free).
 *
 * Scenario: ada and grace share room1, linus sits in room2.
 *   - join system events carry the roster size
 *   - a message from ada reaches grace (and ada) in room1
 *   - linus in room2 never sees room1 traffic
 *   - ada leaving shrinks the room1 roster
 *
 * Exits 0 when every check passes. Every wait is bounded and clears its
 * timer, so nothing dangles.
 */
const base = process.argv[2];
if (base === undefined) {
  console.error('usage: bun smoke-ws.ts <http-base-url>');
  process.exit(2);
}
const wsBase = base.replace(/^http/, 'ws');

let failures = 0;
const check = (name: string, ok: boolean, detail?: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) failures += 1;
};

type ChatMessage = {
  type: 'system' | 'message';
  room: string;
  text: string;
  from?: string;
  members?: number;
};

/** A socket plus a queue of parsed messages. */
type Client = {
  readonly socket: WebSocket;
  readonly inbox: ChatMessage[];
};

const connect = (path: string): Promise<Client> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBase}${path}`);
    const client: Client = { socket, inbox: [] };
    socket.onmessage = (event) => {
      client.inbox.push(JSON.parse(String(event.data)) as ChatMessage);
    };
    socket.onopen = () => resolve(client);
    socket.onerror = () => reject(new Error(`connect failed: ${path}`));
  });

/** Resolves the first queued message matching `want` (bounded wait). */
const receive = (
  client: Client,
  want: (message: ChatMessage) => boolean,
  withinMs = 2_000
): Promise<ChatMessage | undefined> =>
  new Promise((resolve) => {
    const found = (): ChatMessage | undefined => client.inbox.find(want);
    let first = found();
    if (first !== undefined) {
      resolve(first);
      return;
    }
    const timer = setTimeout(() => {
      client.socket.removeEventListener('message', onArrival as EventListener);
      resolve(found());
    }, withinMs);
    const onArrival = (): void => {
      first = found();
      if (first !== undefined) {
        clearTimeout(timer);
        client.socket.removeEventListener('message', onArrival as EventListener);
        resolve(first);
      }
    };
    client.socket.addEventListener('message', onArrival);
  });

/** Resolves true when nothing matching `unwanted` arrives within the window. */
const silenceFor = (
  client: Client,
  unwanted: (message: ChatMessage) => boolean,
  withinMs: number
): Promise<boolean> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.socket.removeEventListener('message', onArrival as EventListener);
      resolve(!client.inbox.some(unwanted));
    }, withinMs);
    const onArrival = (): void => {
      if (unwanted(client.inbox[client.inbox.length - 1])) {
        clearTimeout(timer);
        client.socket.removeEventListener('message', onArrival as EventListener);
        resolve(false);
      }
    };
    client.socket.addEventListener('message', onArrival);
  });

const ada = await connect('/chat/room1?name=ada');
const grace = await connect('/chat/room1?name=grace');
const linus = await connect('/chat/room2?name=linus');

const ownJoin = await receive(ada, (m) => m.type === 'system' && m.text === 'ada joined');
check('ada sees her own join with members=1', ownJoin !== undefined && ownJoin.members === 1);

const graceJoinForAda = await receive(ada, (m) => m.text === 'grace joined');
const graceJoinForGrace = await receive(grace, (m) => m.text === 'grace joined');
check(
  'grace joining reaches both room1 peers with members=2',
  graceJoinForAda?.members === 2 && graceJoinForGrace?.members === 2
);
const linusJoin = await receive(linus, (m) => m.text === 'linus joined');
check('linus joins room2 (his own roster)', linusJoin?.room === 'room2' && linusJoin.members === 1);

// Broadcast: ada's message reaches grace and ada herself in room1.
ada.socket.send('hello room');
const toGrace = await receive(grace, (m) => m.type === 'message' && m.text === 'hello room');
const toAda = await receive(ada, (m) => m.type === 'message' && m.text === 'hello room');
check(
  'message broadcasts to the other peer with sender identity',
  toGrace?.from === 'ada' && toGrace.room === 'room1'
);
check('sender also receives the broadcast', toAda?.from === 'ada');

// Isolation: fresh room1 traffic must not reach room2 in either direction.
ada.socket.send('room1 secret');
await receive(grace, (m) => m.text === 'room1 secret');
const leaked = await silenceFor(linus, (m) => m.text === 'room1 secret', 150);
check('room2 never sees room1 traffic', leaked);

// Leave cleanup: ada closing shrinks room1 for grace.
ada.socket.close();
const left = await receive(grace, (m) => m.text === 'ada left');
check('leave broadcasts the shrunk roster', left?.members === 1);

grace.socket.close();
linus.socket.close();

check('all checks passed', failures === 0);
process.exit(failures === 0 ? 0 : 1);
