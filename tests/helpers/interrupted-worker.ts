import { executeRun } from "../../packages/runtime/src/index";
import { MockProvider, type Message } from "../../packages/providers/src/index";
class PausingProvider extends MockProvider {
  override async infer(
    ...args: Parameters<MockProvider["infer"]>
  ): Promise<Message> {
    if (args[0].some((m) => m.parts?.some((p) => p.functionResponse))) {
      console.log("CHECKPOINTED");
      await new Promise(() => {});
    }
    return super.infer(...args);
  }
}
await executeRun(process.argv[2], {
  provider: new PausingProvider(),
  dispatch: async () => ({ ok: true, data: { accepted: true } }),
});
