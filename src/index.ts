#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type CallToolRequest,
  type ReadResourceRequest
} from '@modelcontextprotocol/sdk/types.js'

import { loadConfig, loadEnvironment } from './config.js'
import { createGraphQLClient } from './graphql.js'
import { enforceMutationSafety, enforceMutationPath, auditMutation } from './safety.js'
import { errorResult } from './errors.js'
import { allTools } from './tools/registry.js'
import {
  markdownGuideResource,
  markdownGuideContent,
  MARKDOWN_GUIDE_URI
} from './resources/markdownGuide.js'
import {
  permissionsGuideResource,
  permissionsGuideContent,
  PERMISSIONS_GUIDE_URI
} from './resources/permissionsGuide.js'
import {
  mermaidGuideResource,
  mermaidGuideContent,
  MERMAID_GUIDE_URI
} from './resources/mermaidGuide.js'
import type { ToolContext, WikiConfig } from './types.js'

type TransportMode = 'http' | 'stdio'

const SERVER_NAME = '@yowu-dev/requarks-wiki-mcp'
const SERVER_VERSION = '0.3.1'

const toolMap = new Map(allTools.map((t) => [t.definition.name, t]))

if (toolMap.size !== allTools.length) {
  const names = allTools.map((t) => t.definition.name)
  const dupes = names.filter((n, i) => names.indexOf(n) !== i)
  throw new Error(`Duplicate tool names detected: ${dupes.join(', ')}`)
}

function createToolContext(config: WikiConfig): ToolContext {
  const graphql = createGraphQLClient(config)

  return {
    config,
    graphql,
    enforceMutationSafety: (confirm: string) => enforceMutationSafety(config, confirm),
    enforceMutationPath: (path: string) => enforceMutationPath(config, path),
    auditMutation
  }
}

function createMcpServer(ctx: ToolContext): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: allTools.map((t) => t.definition) }
  })

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: [markdownGuideResource, permissionsGuideResource, mermaidGuideResource] }
  })

  server.setRequestHandler(ReadResourceRequestSchema, async (request: ReadResourceRequest) => {
    const uri = request.params.uri
    if (uri === MARKDOWN_GUIDE_URI) {
      return {
        contents: [
          {
            uri: MARKDOWN_GUIDE_URI,
            mimeType: 'text/markdown',
            text: markdownGuideContent
          }
        ]
      }
    }
    if (uri === PERMISSIONS_GUIDE_URI) {
      return {
        contents: [
          {
            uri: PERMISSIONS_GUIDE_URI,
            mimeType: 'text/markdown',
            text: permissionsGuideContent
          }
        ]
      }
    }
    if (uri === MERMAID_GUIDE_URI) {
      return {
        contents: [
          {
            uri: MERMAID_GUIDE_URI,
            mimeType: 'text/markdown',
            text: mermaidGuideContent
          }
        ]
      }
    }
    return { contents: [], isError: true }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    const name = request.params.name
    const args = (request.params.arguments ?? {}) as Record<string, unknown>

    const tool = toolMap.get(name)
    if (!tool) {
      return errorResult(`Unknown tool: ${name}`)
    }

    try {
      return await tool.handler(ctx, args)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Sanitize: take only first line and limit length to prevent leaking stack traces.
      const sanitized = message.split('\n')[0].substring(0, 500)
      return errorResult(sanitized)
    }
  })

  return server
}

function getTransportMode(): TransportMode {
  const args = new Set(process.argv.slice(2))
  if (args.has('--http')) return 'http'
  if (args.has('--stdio')) return 'stdio'

  const raw = (process.env.MCP_TRANSPORT ?? process.env.WIKI_MCP_TRANSPORT ?? 'stdio').toLowerCase()
  return raw === 'http' || raw === 'sse' ? 'http' : 'stdio'
}

function getHttpListenConfig() {
  const portRaw = process.env.MCP_PORT ?? process.env.PORT ?? '3200'
  const port = Number.parseInt(portRaw, 10)

  return {
    host: process.env.MCP_HOST ?? process.env.HOST ?? '0.0.0.0',
    port: Number.isInteger(port) && port > 0 ? port : 3200
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(payload))
}

async function startStdioServer(ctx: ToolContext) {
  const server = createMcpServer(ctx)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

async function startHttpServer(ctx: ToolContext) {
  const sessions = new Map<string, { server: Server; transport: SSEServerTransport }>()
  const { host, port } = getHttpListenConfig()

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`)

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          name: SERVER_NAME,
          transport: 'sse',
          sessions: sessions.size
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/sse') {
        // Each SSE connection owns a fresh MCP Server and transport. Reusing either
        // across clients causes "Already connected to a transport" failures.
        const transport = new SSEServerTransport('/message', res)
        const server = createMcpServer(ctx)
        sessions.set(transport.sessionId, { server, transport })

        server.onerror = (error) => {
          process.stderr.write(`[${SERVER_NAME}] MCP session error: ${error.message}\n`)
        }
        server.onclose = () => {
          sessions.delete(transport.sessionId)
        }

        try {
          await server.connect(transport)
        } catch (err) {
          sessions.delete(transport.sessionId)
          throw err
        }
        process.stderr.write(`[${SERVER_NAME}] SSE client connected: ${transport.sessionId}\n`)
        return
      }

      if (req.method === 'POST' && url.pathname === '/message') {
        const sessionId = url.searchParams.get('sessionId')
        if (!sessionId) {
          sendJson(res, 400, { error: 'Missing sessionId query parameter' })
          return
        }

        const session = sessions.get(sessionId)
        if (!session) {
          sendJson(res, 404, { error: 'Unknown or closed sessionId' })
          return
        }

        await session.transport.handlePostMessage(req, res)
        return
      }

      sendJson(res, 404, { error: 'Not found' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[${SERVER_NAME}] HTTP request failed: ${message}\n`)
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error' })
      } else if (!res.writableEnded) {
        res.end()
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject)
      resolve()
    })
  })

  process.stderr.write(
    `[${SERVER_NAME}] HTTP/SSE server listening on http://${host}:${port} ` +
      '(SSE: /sse, messages: /message)\n'
  )

  const shutdown = async (signal: NodeJS.Signals) => {
    process.stderr.write(`[${SERVER_NAME}] received ${signal}, shutting down\n`)
    httpServer.close()

    await Promise.allSettled(
      [...sessions.values()].map(async ({ server }) => {
        await server.close()
      })
    )
    sessions.clear()
  }

  process.once('SIGINT', () => {
    void shutdown('SIGINT').finally(() => process.exit(0))
  })
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').finally(() => process.exit(0))
  })
}

async function main() {
  loadEnvironment()
  const config = loadConfig()
  const ctx = createToolContext(config)

  if (getTransportMode() === 'http') {
    await startHttpServer(ctx)
    return
  }

  await startStdioServer(ctx)
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`[${SERVER_NAME}] startup failed: ${msg}\n`)
  process.exit(1)
})
