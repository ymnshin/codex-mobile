import pino from "pino";

export function createLogger(level: pino.LevelWithSilent = "info") {
  const options: pino.LoggerOptions = { level };
  if (process.env.NODE_ENV !== "test") {
    options.transport = {
      target: "pino/file",
      options: {
        destination: 1
      }
    };
  }

  return pino(options);
}

export type Logger = ReturnType<typeof createLogger>;
