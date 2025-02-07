interface Env {
  JOBBER_API_URL: string;
  JOBBER_API_VERSION: string;
  JOBBER_API_CLIENT_ID: string;
  JOBBER_API_CLIENT_SECRET: string;
  JOBBER_PROXY_URL: string;
  JOBBER_PROXY_KV: KVNamespace;
}

const JOBBER_API_TOKEN_PATH = "/api/oauth/token";
const JOBBER_API_AUTHORIZE_PATH = "/api/oauth/authorize";
const JOBBER_API_GRAPHQL_PATH = "/api/graphql";
const JOBBER_PROXY_STATE = "jpstate10273";
const JOBBER_PROXY_SCOPE = [
  "read_clients",
  "write_clients",
  "read_requests",
  "write_requests",
  "read_quotes",
  "write_quotes",
  "read_jobs",
  "write_jobs",
  "read_scheduled_items",
  "write_scheduled_items",
  "read_invoices",
  "write_invoices",
  "read_jobber_payments",
  "read_users",
  "write_users",
  "write_tax_rates",
  "read_expenses",
  "write_expenses",
  "read_custom_field_configurations",
  "write_custom_field_configurations",
  "read_time_sheets",
  "read_equipment",
  "write_equipment",
];

export default {
  async fetch(req: Request, env: Env, _: unknown): Promise<Response> {
    const url = new URL(req.url);
    try {
      switch (url.pathname) {
        case "/":
          return new Response("Hi Joe :)", { status: 200 });
        case "/callback":
          return await callback(req, env);
        case "/authorize":
          return await authorize(env);
        case "/graphql":
          return await proxy(req, env);
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (e) {
      console.error(e);
      return new Response("sorry, broken :/", { status: 500 });
    }
  },
};

async function proxy(req: Request, env: Env): Promise<Response> {
  // get new access token
  let tokens: { access_token: string; refresh_token: string };
  try {
    tokens = await refreshTokens(env);
    console.log("tokens refreshed for proxy action");
  } catch (e) {
    throw new Error(`unable to refresh tokens: ${e}`);
  }

  // setup request to jobber
  const jobberHeaders = new Headers();
  jobberHeaders.append("Content-Type", "application/json");
  jobberHeaders.append("Accept", "application/json");
  jobberHeaders.append("User-Agent", "JWCloudflareWorker/1.0");
  jobberHeaders.append("Authorization", `Bearer ${tokens.access_token}`);
  jobberHeaders.append("X-JOBBER-GRAPHQL-VERSION", `${env.JOBBER_API_VERSION}`);
  const body = await req.arrayBuffer();
  const jobberRequest = new Request(
    env.JOBBER_API_URL + JOBBER_API_GRAPHQL_PATH,
    {
      method: "POST",
      headers: jobberHeaders,
      body: body,
    },
  );
  console.log("jobber request headers and body set");

  // proxy the request to jobber, now with the needed headers
  return fetch(jobberRequest);
}

async function authorize(env: Env): Promise<Response> {
  // create the authorization url for manually triggering auth code callback
  const params = new URLSearchParams({
    client_id: env.JOBBER_API_CLIENT_ID,
    response_type: "code",
    redirect_uri: env.JOBBER_PROXY_URL + "/callback",
    state: JOBBER_PROXY_STATE,
    scope: JOBBER_PROXY_SCOPE.join(" "),
  });
  const authorizationUrl =
    env.JOBBER_API_URL + JOBBER_API_AUTHORIZE_PATH + "?" + params.toString();

  // return the authorization url
  return new Response(JSON.stringify({ authorization_url: authorizationUrl }), {
    status: 200,
  });
}

async function callback(req: Request, env: Env): Promise<Response> {
  // extract code and state from redirect
  const reqUrl = new URL(req.url);
  const code = reqUrl.searchParams.get("code") || "";
  const state = reqUrl.searchParams.get("state") || "";
  if (code == "" || state != JOBBER_PROXY_STATE) {
    throw new Error("invalid code or state");
  }
  console.log("code and state extracted from redirect url");

  // set up access token request
  const tokenRequestHeaders = new Headers();
  tokenRequestHeaders.append(
    "Content-Type",
    "application/x-www-form-urlencoded",
  );
  const tokenRequestParams = new URLSearchParams();
  tokenRequestParams.append("grant_type", "authorization_code");
  tokenRequestParams.append("client_id", env.JOBBER_API_CLIENT_ID);
  tokenRequestParams.append("client_secret", env.JOBBER_API_CLIENT_SECRET);
  tokenRequestParams.append("code", code);
  tokenRequestParams.append("redirect_uri", env.JOBBER_PROXY_URL + "/callback");
  const tokenRequest = new Request(env.JOBBER_API_URL + JOBBER_API_TOKEN_PATH, {
    method: "POST",
    headers: tokenRequestHeaders,
    body: tokenRequestParams.toString(),
  });
  console.log("access token request headers and params set");

  // get access and refresh tokens
  try {
    const tokenResponse = await fetch(tokenRequest);
    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
    };
    await env.JOBBER_PROXY_KV.put(
      "JOBBER_API_REFRESH_TOKEN",
      tokens.refresh_token,
    );
    console.log("access and refresh tokens retrieved and saved");
  } catch (e) {
    throw new Error(`failed to get access tokens: ${e}`);
  }

  // return success
  return new Response("Authorized - tokens securely saved", { status: 200 });
}

async function refreshTokens(
  env: Env,
): Promise<{ access_token: string; refresh_token: string }> {
  // get refresh token from secure storage
  const refreshToken =
    (await env.JOBBER_PROXY_KV.get("JOBBER_API_REFRESH_TOKEN")) || "";
  if (refreshToken === "") {
    throw new Error("no refresh token found");
  }

  // set up access token request using refresh token
  const tokenRequestHeaders = new Headers();
  tokenRequestHeaders.append(
    "Content-Type",
    "application/x-www-form-urlencoded",
  );
  const tokenRequestParams = new URLSearchParams();
  tokenRequestParams.append("grant_type", "refresh_token");
  tokenRequestParams.append("client_id", env.JOBBER_API_CLIENT_ID);
  tokenRequestParams.append("client_secret", env.JOBBER_API_CLIENT_SECRET);
  tokenRequestParams.append("refresh_token", refreshToken);
  const tokenRequest = new Request(env.JOBBER_API_URL + JOBBER_API_TOKEN_PATH, {
    method: "POST",
    headers: tokenRequestHeaders,
    body: tokenRequestParams.toString(),
  });

  // get new access and refresh tokens
  let tokens: { access_token: string; refresh_token: string };
  try {
    const tokenResponse = await fetch(tokenRequest);
    tokens = await tokenResponse.json();
    await env.JOBBER_PROXY_KV.put(
      "JOBBER_API_REFRESH_TOKEN",
      tokens.refresh_token,
    );
  } catch (e) {
    throw new Error(`failed to refresh access tokens: ${e}`);
  }

  // return new tokens
  return tokens;
}
