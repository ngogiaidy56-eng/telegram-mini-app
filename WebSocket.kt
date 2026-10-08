package com.vietsub.edge

import kotlin.js.Promise

@JsExport
external interface Request {
    val url: String
    val method: String
    val headers: dynamic
}

@JsExport
external interface ResponseInit {
    var status: Int?
    var statusText: String?
    var headers: dynamic
    var webSocket: dynamic
}

@JsExport
external class Response(body: dynamic, init: ResponseInit? = definedExternally) {
    companion object {
        fun json(body: dynamic, init: ResponseInit? = definedExternally): Response
    }
}

@JsExport
external class WebSocketPair {
    val 0: dynamic
    val 1: dynamic
}

@JsExport
fun fetch(request: Request, env: dynamic, ctx: dynamic): Promise<Response> {
    val url = js("new URL(request.url)")
    val pathname = url.pathname as String
    val method = request.method as String

    // Handle WebSocket upgrade at Edge
    if (pathname == "/ws" || pathname.startsWith("/ws/jobs")) {
        val upgradeHeader = request.headers.get("Upgrade")
        if (upgradeHeader != "websocket") {
            return Promise.resolve(Response("Expected Upgrade: websocket", js("{ status: 426 }")))
        }

        val pair = WebSocketPair()
        val client = pair.`0`
        val server = pair.`1`

        server.accept()

        server.addEventListener("message", { event: dynamic ->
            val data = event.data as String
            server.send("{\"type\":\"ACK\",\"status\":\"RECEIVED\",\"data\":$data}")
        })

        server.addEventListener("close", {
            // Connection closed cleanup
        })

        val init = js("{}")
        init.status = 101
        init.webSocket = client
        return Promise.resolve(Response(null, init))
    }

    // Handle API endpoint for AI Manager
    if (pathname == "/api/ai/manage" && method == "POST") {
        return handleAiManager(env)
    }

    // Handle System Telemetry stats
    if (pathname == "/api/system/stats") {
        val stats = js("{}")
        stats.version = "3.5.0-KOTLIN-EDGE"
        stats.environment = "Cloudflare Workers Edge"
        stats.status = "ONLINE"
        stats.uptimeSeconds = 86400
        return Promise.resolve(Response.json(stats))
    }

    return Promise.resolve(Response("VietSub Video Studio Cloud-Native Kotlin Edge Worker Active 🚀", js("{ status: 200 }")))
}

fun handleAiManager(env: dynamic): Promise<Response> {
    val result = js("{}")
    result.success = true
    val data = js("{}")
    data.action = "SYSTEM_STATUS"
    data.reply = "🤖 Kotlin AI Manager tại Cloudflare Edge đã tiếp nhận lệnh thành công!"
    result.data = data
    return Promise.resolve(Response.json(result))
}