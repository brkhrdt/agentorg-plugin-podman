import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { RpcClient } from "./rpc.ts";

const path = process.env.ORG_SOCKET;
if (!path) throw new Error("ORG_SOCKET is required");
const client = new RpcClient(path);
const server = new Server({ name: "agentorg-podman", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => client.request<ListToolsResult>("mcp.list"));
server.setRequestHandler(CallToolRequestSchema, request => client.request<CallToolResult>("mcp.call", { name: request.params.name, arguments: request.params.arguments ?? {} }));
await server.connect(new StdioServerTransport());
let closing = false;
async function close() { if (closing) return; closing = true; client.close(); await server.close(); }
process.stdin.on("end", () => { void close(); });
process.on("SIGTERM", () => { void close().finally(() => process.exit(0)); });
