import { describe, expect, it, vi } from "vitest";
import { createGracefulShutdown } from "../../src/lifecycle/shutdown";

const silent = () => {};

describe("apagado ordenado", () => {
  it("ejecuta los pasos en orden y sale con 0", async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createGracefulShutdown(
      ["uno", "dos", "tres"].map((name) => ({ name, run: async () => void order.push(name) })),
      { timeoutMs: 1_000, log: silent, exit }
    );
    await shutdown("SIGTERM");
    expect(order).toEqual(["uno", "dos", "tres"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("si un paso falla, no ejecuta los siguientes y sale con 1", async () => {
    const exit = vi.fn();
    const after = vi.fn();
    const shutdown = createGracefulShutdown(
      [
        { name: "falla", run: () => Promise.reject(new Error("boom")) },
        { name: "después", run: after },
      ],
      { timeoutMs: 1_000, log: silent, exit }
    );
    await shutdown("SIGTERM");
    expect(after).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("una segunda señal mientras se apaga no repite los pasos", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const shutdown = createGracefulShutdown([{ name: "paso", run }], { timeoutMs: 1_000, log: silent, exit: vi.fn() });
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("si un paso se cuelga, fuerza la salida con 1 al cumplirse el tiempo máximo", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const shutdown = createGracefulShutdown([{ name: "colgado", run: () => new Promise(() => {}) }], {
      timeoutMs: 500,
      log: silent,
      exit,
    });
    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(500);
    expect(exit).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });
});
