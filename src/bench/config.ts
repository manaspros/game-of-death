export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Set it before running, e.g.:\n` +
        `  ${name}=... npm run bench`,
    );
  }
  return value;
}
