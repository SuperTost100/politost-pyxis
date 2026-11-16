import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { createServer as createTcpServer, type AddressInfo } from "node:net";

/**
 * What the session's request filter cannot see: WebRTC opens its own sockets (UDP to a STUN or TURN server), and
 * `<link rel=preconnect>` and `dns-prefetch` are the network stack's own work, with a connection or a DNS lookup and no
 * request. The page tries them against a UDP listener, a TCP server and names nothing resolves: `host` for everything but
 * a dns-prefetch hint, and `hintHost` for that one alone, because it is the one the session cannot stop (see the tests).
 */
export function networkStackScript(host: string, hintHost: string, udpPort: number, tcpPort: number): string {
  return `(async () => {
          const out = {};
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          try {
            const pc = new RTCPeerConnection({
              iceServers: [
                { urls: "stun:127.0.0.1:${udpPort}" },
                { urls: "turn:127.0.0.1:${udpPort}?transport=udp", username: "u", credential: "c" },
                { urls: "turn:127.0.0.1:${tcpPort}?transport=tcp", username: "u", credential: "c" },
                { urls: "stun:${host}:3478" },
              ],
              iceTransportPolicy: "all",
            });
            pc.createDataChannel("x");
            await pc.setLocalDescription(await pc.createOffer());
            await Promise.race([new Promise((resolve) => { pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") resolve(); }; }), wait(5000)]);
            out.webrtc = "gathered " + pc.iceGatheringState;
            pc.close();
          } catch (error) { out.webrtc = "refused " + String(error).slice(0, 60); }
          for (const [rel, href] of [["preconnect", "http://127.0.0.1:${tcpPort}/preconnect"], ["dns-prefetch", "//${hintHost}"], ["preconnect", "http://${host}/"], ["prefetch", "http://127.0.0.1:${tcpPort}/prefetch"], ["preload", "http://127.0.0.1:${tcpPort}/preload"]]) {
            const link = document.createElement("link");
            link.rel = rel;
            if (rel === "preload") link.as = "image";
            link.href = href;
            document.head.append(link);
          }
          await wait(2500);
          return out;
        })()`;
}

/** A UDP listener and a TCP server on this machine that count what reaches them, for what a page might reach out to. */
export async function listeners() {
  const udp = createSocket("udp4");
  const datagrams: string[] = [];
  udp.on("message", (message, from) => datagrams.push(`${from.address}:${from.port} ${message.length} bytes`));
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
  const connections: string[] = [];
  const tcp = createTcpServer((socket) => {
    connections.push(`${socket.remoteAddress}:${socket.remotePort}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  return {
    datagrams,
    connections,
    udpPort: udp.address().port,
    tcpPort: (tcp.address() as AddressInfo).port,
    close: async () => {
      udp.close();
      await new Promise((resolve) => tcp.close(resolve));
    },
  };
}

/** The host names of a NetLog file that the network stack did resolver work for. */
export function resolved(file: string, host: string): string[] {
  const netLog = JSON.parse(readFileSync(file, "utf8")) as {
    constants: { logEventTypes: Record<string, number> };
    events: Array<{ type: number; params?: unknown }>;
  };
  const names = Object.fromEntries(Object.entries(netLog.constants.logEventTypes).map(([name, id]) => [id, name]));
  return netLog.events
    .filter((event) => /^HOST_RESOLVER/.test(names[event.type] ?? "") && JSON.stringify(event.params ?? "").includes(host))
    .map((event) => `${names[event.type]}:${JSON.stringify(event.params ?? "").slice(0, 160)}`);
}
