import { minimalSubprocessEnv } from "./subprocess-env";

export type SpawnFn = (cmd: string[]) => Promise<{ exitCode: number; stderr: string }>;

export const realSpawn: SpawnFn = async (cmd) => {
  const proc = Bun.spawn(cmd, { env: minimalSubprocessEnv(), stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stderr };
};
