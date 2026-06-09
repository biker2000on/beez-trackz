import { NextRequest } from "next/server";
import { server as mcpServer } from "@/mcp/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { verifySession } from "@/lib/session";

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

async function isRequestAuthenticated(req: NextRequest): Promise<boolean> {
  const authHeader = req.headers.get("authorization");
  let token: string | undefined;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  } else {
    token = req.cookies.get("session")?.value;
  }

  if (!token) {
    return false;
  }

  return verifySession(token);
}

const UNAUTHORIZED_RESPONSE = () => new Response(JSON.stringify({
  jsonrpc: "2.0",
  error: {
    code: -32099,
    message: "Authentication required. Please authenticate at /api/mcp/login."
  },
  id: null
}), {
  status: 401,
  headers: { "Content-Type": "application/json" }
});

export async function GET(req: NextRequest) {
  if (!(await isRequestAuthenticated(req))) {
    return UNAUTHORIZED_RESPONSE();
  }
  return transport.handleRequest(req);
}

export async function POST(req: NextRequest) {
  if (!(await isRequestAuthenticated(req))) {
    return UNAUTHORIZED_RESPONSE();
  }
  return transport.handleRequest(req);
}

export async function DELETE(req: NextRequest) {
  if (!(await isRequestAuthenticated(req))) {
    return UNAUTHORIZED_RESPONSE();
  }
  return transport.handleRequest(req);
}
