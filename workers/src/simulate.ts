import createFCV1Module from "./fcv1_simulator.mjs";
import wasmModule from "./fcv1_simulator.wasm";

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
    }) as Promise<FCV1Module>;
  }
  return instancePromise;
}

export async function handleSimulate(request: Request): Promise<Response> {
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
