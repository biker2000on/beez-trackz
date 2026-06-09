import { NextRequest } from "next/server";
import { server as mcpServer } from "@/mcp/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

// Keep references globally to survive hot-reloading in development
const globalForMcp = global as unknown as {
  mcpTransport?: WebStandardStreamableHTTPServerTransport;
  mcpConnected?: boolean;
};

const transport = globalForMcp.mcpTransport ?? new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
});

if (process.env.NODE_ENV !== "production") {
  globalForMcp.mcpTransport = transport;
}

if (!globalForMcp.mcpConnected) {
  // Connect the MCP server to the web transport
  await mcpServer.connect(transport);
  globalForMcp.mcpConnected = true;
}

export async function GET(req: NextRequest) {
  return transport.handleRequest(req);
}

export async function POST(req: NextRequest) {
  return transport.handleRequest(req);
}

export async function DELETE(req: NextRequest) {
  return transport.handleRequest(req);
}
