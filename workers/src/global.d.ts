declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "*fcv1_simulator.mjs" {
  interface FCV1ModuleOverrides {
    instantiateWasm?: (
      imports: WebAssembly.Imports,
      successCallback: (instance: WebAssembly.Instance) => void,
    ) => object;
  }
  export default function createFCV1Module(
    overrides?: FCV1ModuleOverrides,
  ): Promise<unknown>;
}
