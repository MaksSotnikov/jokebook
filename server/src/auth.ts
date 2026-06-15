import { hash, verify } from '@node-rs/argon2'

/** Hash a plaintext password for storage. */
export function hashPassword(password: string): Promise<string> {
  return hash(password)
}

/** Verify a plaintext password against a stored hash. */
export function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  return verify(storedHash, password)
}
