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

/**
 * Wasmインスタンス経由で`simulate_json`を直接呼び出す(HTTPラウンドトリップなし)。
 * `handleSimulate`(デバッグ用HTTPエンドポイント)と投球処理エンドポイント(Task06)の両方から使う。
 */
export async function callSimulateJson(
  inputJson: string,
): Promise<{ result: string; elapsedMs: number }> {
  const instance = await getInstance();

  const inputBytes = instance.lengthBytesUTF8(inputJson) + 1;
  const inputPtr = instance._malloc(inputBytes);
  instance.stringToUTF8(inputJson, inputPtr, inputBytes);

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

  return { result, elapsedMs };
}

export async function handleSimulate(request: Request): Promise<Response> {
  const body = await request.text();
  const { result, elapsedMs } = await callSimulateJson(body);

  return new Response(
    JSON.stringify({ result: JSON.parse(result), elapsed_ms: elapsedMs }),
    { headers: { "content-type": "application/json" } },
  );
}
