/**
 * Creates (or resets) a single admin account from ADMIN_EMAIL / ADMIN_PASSWORD
 * / ADMIN_NAME in .env — the only way a user ever gets into this database
 * (there is no seed script; it was deliberately deleted). Touches nothing but
 * that one User row. Safe to re-run: upserts by email, so it also doubles as
 * a recovery path if the only admin's password is ever lost (also clears any
 * lockout).
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/server/password";

const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const fullName = process.env.ADMIN_NAME || "Admin";

  if (!email || !password) {
    throw new Error(
      "Set ADMIN_EMAIL and ADMIN_PASSWORD in .env before running this script (see .env.example).",
    );
  }
  if (password.length < 8) {
    throw new Error("ADMIN_PASSWORD must be at least 8 characters.");
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, fullName, role: "admin", status: "active", passwordHash },
    update: {
      fullName,
      role: "admin",
      status: "active",
      passwordHash,
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });

  console.log(`Admin ready: ${user.email} (id ${user.id})`);
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
