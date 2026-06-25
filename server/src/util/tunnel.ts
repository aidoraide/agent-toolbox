import net from "node:net";

export interface Proxy {
  port: number;
  close: () => void;
}

// A TCP proxy bound on `bindHost` (0.0.0.0 by default) that forwards every
// connection to `target`. Used to expose a leased emulator's adb daemon
// (127.0.0.1:adbd) on a host-reachable port, so a Docker container can
// `adb connect host.docker.internal:<port>` from its own adb server.
export function openProxy(
  target: { host: string; port: number },
  bindHost = "0.0.0.0",
): Promise<Proxy> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((client) => {
      sockets.add(client);
      const upstream = net.connect(target.port, target.host);
      client.pipe(upstream);
      upstream.pipe(client);
      const cleanup = () => {
        client.destroy();
        upstream.destroy();
        sockets.delete(client);
      };
      client.on("error", cleanup);
      upstream.on("error", cleanup);
      client.on("close", cleanup);
    });
    server.on("error", reject);
    server.listen(0, bindHost, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}
