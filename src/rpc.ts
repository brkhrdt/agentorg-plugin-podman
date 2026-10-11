import { createConnection, type Socket } from "node:net";

/** Small bounded JSONL client; no runtime dependency on the organization host. */
export class RpcClient {
  private socket: Socket;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private buffer = "";
  constructor(path: string, private token?: string) {
    this.socket = createConnection(path);
    this.socket.setEncoding("utf8");
    this.socket.on("error", error => this.fail(error));
    this.socket.on("close", () => this.fail(new Error("Organization connection closed")));
    this.socket.on("data", chunk => {
      this.buffer += chunk.toString();
      if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) { this.close(); return; }
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try {
          const response = JSON.parse(line);
          if (response.kind !== "response") continue;
          const request = this.pending.get(response.id);
          if (!request) continue;
          this.pending.delete(response.id); clearTimeout(request.timer);
          if (response.ok) request.resolve(response.result);
          else request.reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
        } catch { this.close(); return; }
      }
    });
  }
  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (this.socket.destroyed) return Promise.reject(new Error("Organization connection closed"));
    if (this.pending.size >= 64) return Promise.reject(new Error("Too many outstanding requests"));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Organization request timed out")); }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, params, ...(this.token && { token: this.token }) }) + "\n");
    });
  }
  private fail(error: Error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  close() { this.socket.destroy(); this.fail(new Error("Organization connection closed")); }
}
