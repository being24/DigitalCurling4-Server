import createFCV1Module from "./fcv1_simulator.mjs";
import wasmModule from "./fcv1_simulator.wasm";
import { MatchRoom } from "./match_room";

export { MatchRoom };

export interface Env {
  MATCH_ROOM: DurableObjectNamespace<MatchRoom>;
}

interface FCV1Module {
  _malloc(size: number): number;
  _free(ptr: number): void;
  ccall(
    ident: string,
    returnType: string,
    argTypes: string[],
    args: number[],
  ): number;
  UTF8ToString(ptr: number): string;
  stringToUTF8(str: string, ptr: number, maxBytes: number): number;
  lengthBytesUTF8(str: string): number;
}

let instancePromise: Promise<FCV1Module> | null = null;
function getInstance(): Promise<FCV1Module> {
  if (!instancePromise) {
    instancePromise = createFCV1Module({
      instantiateWasm(
        imports: WebAssembly.Imports,
        successCallback: (instance: WebAssembly.Instance) => void,
      ) {
        WebAssembly.instantiate(wasmModule, imports).then((instance) => {
          successCallback(instance);
        });
        return {};
      },
    });
  }
  return instancePromise;
}

async function handleSimulate(request: Request): Promise<Response> {
  const instance = await getInstance();
  const body = await request.text();

  const inputBytes = instance.lengthBytesUTF8(body) + 1;
  const inputPtr = instance._malloc(inputBytes);
  instance.stringToUTF8(body, inputPtr, inputBytes);

  const t0 = Date.now();
  const resultPtr = instance.ccall(
    "simulate_json",
    "number",
    ["number"],
    [inputPtr],
  );
  const elapsedMs = Date.now() - t0;
  const result = instance.UTF8ToString(resultPtr);
  instance._free(inputPtr);

  return new Response(
    JSON.stringify({ result: JSON.parse(result), elapsed_ms: elapsedMs }),
    { headers: { "content-type": "application/json" } },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/simulate") {
      return handleSimulate(request);
    }

    if (url.pathname === "/ws") {
      const matchId = url.searchParams.get("match");
      if (!matchId) {
        return new Response("missing ?match=<id>", { status: 400 });
      }
      const stub = env.MATCH_ROOM.getByName(matchId);
      return stub.fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
};
