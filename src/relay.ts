import { createServer, type Socket } from "node:net";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient } from "./rpc.ts";

/** Only the socket inode is mounted, never this directory or the public server socket. */
export async function createRelay(organizationSocket: string, token: string) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "aop-")));
  await chmod(dir, 0o700);
  const path = join(dir, "mcp.sock");
  const connections = new Set<Socket>();
  const server = createServer(socket => {
    if (connections.size >= 32) { socket.destroy(); return; }
    connections.add(socket); socket.setEncoding("utf8");
    const client = new RpcClient(organizationSocket, token);
    let buffer = "", inflight = 0;
    socket.on("error", () => {});
    socket.on("close", () => { connections.delete(socket); client.close(); });
    const send = (response: unknown) => {
      const line = JSON.stringify(response) + "\n";
      if (socket.writableLength + Buffer.byteLength(line) > 4 * 1024 * 1024) socket.destroy();
      else if (!socket.destroyed) socket.write(line);
    };
    const handle = async (line: string) => {
      let id: string | number | null = null;
      try {
        const request = JSON.parse(line);
        if (typeof request.id !== "string" && typeof request.id !== "number") throw new Error("Request ID required");
        id = request.id;
        if (!["mcp.list", "mcp.call"].includes(request.method)) throw Object.assign(new Error("Relay permits only MCP requests"), { code: "FORBIDDEN" });
        // Ignore all model-supplied identity/token fields. Core validates the host-held generation token.
        const result = await client.request(request.method, request.params ?? {});
        send({ kind: "response", id, ok: true, result });
      } catch (error: any) {
        send({ kind: "response", id, ok: false, error: { code: error.code ?? "INVALID_PARAMS", message: error.message } });
      } finally { inflight--; }
    };
    socket.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) { socket.destroy(); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (++inflight > 64) { socket.destroy(); return; }
        void handle(line);
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    await chmod(path, 0o600);
  } catch (error) { server.close(); await rm(dir, { recursive: true, force: true }); throw error; }
  let closed = false;
  return { path, async close() {
    if (closed) return;
    closed = true;
    for (const connection of connections) connection.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  } };
}
