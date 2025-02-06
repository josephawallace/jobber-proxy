import { AuthorizationCode } from "simple-oauth2"

interface Env {
  JOBBER_API_URL: string,
  JOBBER_API_VERSION: string,
  JOBBER_API_CLIENT_ID: string,
  JOBBER_API_CLIENT_SECRET: string,
  JOBBER_PROXY_URL: string,
  JOBBER_PROXY_KV: KVNamespace,
}

const JOBBER_API_TOKEN_PATH = "/api/oauth/token"
const JOBBER_API_AUTHORIZE_PATH = "/api/oauth/authorize"

export default {
  async fetch(request: Request, env: Env, _: unknown): Promise<Response> {
    // Parse request URL.
    const url = new URL(request.url)

    // Create a new OAuth client with the Jobber API credentials.
    const oauthClient = new AuthorizationCode ({
      client: {
        id: env.JOBBER_API_CLIENT_ID,
        secret: env.JOBBER_API_CLIENT_SECRET,
      },
      auth: {
        tokenHost: env.JOBBER_API_URL,
        authorizeHost: env.JOBBER_API_URL,
        tokenPath: JOBBER_API_TOKEN_PATH,
        authorizePath: JOBBER_API_AUTHORIZE_PATH,
      },
    })

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code") || ""
      try {
        const accessToken = await oauthClient.getToken({
          code: code,
          redirect_uri: `${env.JOBBER_PROXY_URL}/callback`,
        })

        await env.JOBBER_PROXY_KV.put("JOBBER_API_ACCESS_TOKEN", accessToken.token["access_token"] as string || "")
        await env.JOBBER_PROXY_KV.put("JOBBER_API_REFRESH_TOKEN", accessToken.token["refresh_token"] as string || "")
      } catch (e: unknown) {
        return new Response((e as Error).message, { status: 500 })
      }
    }

    let accessToken = await env.JOBBER_PROXY_KV.get("JOBBER_API_ACCESS_TOKEN") || ""
    let refreshToken = await env.JOBBER_PROXY_KV.get("JOBBER_API_REFRESH_TOKEN") || ""
    if (accessToken === "" || refreshToken == "") {
      return new Response("Unauthorized - No token found", { status: 401 })
    }
    let refreshService = oauthClient.createToken({ accessToken: accessToken, refreshToken: refreshToken })

    if (refreshService.expired()) {
      try {
        refreshService = await refreshService.refresh()
      } catch (e: unknown) {
        return new Response((e as Error).message, { status: 500 })
      }
    }
    accessToken = refreshService.token["access_token"] as string
    refreshToken = refreshService.token["refresh_token"] as string

    // Set required Jobber headers.
    const jobberHeaders = new Headers()
    jobberHeaders.append("Content-Type", "application/json")
    jobberHeaders.append("Accept", "application/json")
    jobberHeaders.append("Authorization", `Bearer ${accessToken}`)
    jobberHeaders.append("X-JOBBER-GRAPHQL-VERSION", `${env.JOBBER_API_VERSION}`)

    // Create a new request object with the Jobber headers.
    const jobberRequest = new Request(env.JOBBER_API_URL, {
      method: "POST",
      headers: jobberHeaders,
      body: request.body
    })

    try {
      await env.JOBBER_PROXY_KV.put("JOBBER_API_ACCESS_TOKEN", refreshService.token["access_token"] as string)
      await env.JOBBER_PROXY_KV.put("JOBBER_API_REFRESH_TOKEN", refreshService.token["refresh_token"] as string)
    } catch (e: unknown) {
      return new Response((e as Error).message, { status: 500 })
    }

    // Make the request to the Jobber GraphQL API and return the response.
    return fetch(jobberRequest)
  }
}

