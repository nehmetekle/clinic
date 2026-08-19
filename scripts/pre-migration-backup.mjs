// One-off: export the two columns a pending migration will drop, into one .xlsx.
// Read-only. Usage: PROD_DATABASE_URL="postgresql://..." node scripts/pre-migration-backup.mjs
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import path from "node:path";

const url = process.env.PROD_DATABASE_URL;
if (!url) {
  console.error("Set PROD_DATABASE_URL to the production connection string.");
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url } } });

const columnExists = async (table, column) => {
  const rows = await prisma.$queryRaw`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`;
  return rows.length > 0;
};

const datasets = [
  {
    sheet: "Client.referralFee",
    table: "Client",
    column: "referralFee",
    headers: ["id", "referralFee"],
    sql: `SELECT "id", "referralFee" FROM "Client" WHERE "referralFee" IS NOT NULL ORDER BY "id"`,
  },
  {
    sheet: "ConsultationTreatment.machineOther",
    table: "ConsultationTreatment",
    column: "machineOther",
    headers: ["id", "consultationId", "machineOther"],
    sql: `SELECT "id", "consultationId", "machineOther" FROM "ConsultationTreatment" WHERE "machineOther" IS NOT NULL ORDER BY "id"`,
  },
];

const wb = new ExcelJS.Workbook();
wb.created = new Date();
const summary = [];

for (const d of datasets) {
  const ws = wb.addWorksheet(d.sheet.slice(0, 31));
  ws.addRow(d.headers);
  ws.getRow(1).font = { bold: true };
  if (!(await columnExists(d.table, d.column))) {
    summary.push({ sheet: d.sheet, rows: 0, note: `column "${d.column}" does not exist in the database (already dropped)` });
    ws.addRow([`column "${d.column}" not present in ${d.table} at backup time — nothing to export`]);
  } else {
    const rows = await prisma.$queryRawUnsafe(d.sql);
    for (const r of rows) ws.addRow(d.headers.map((h) => r[h]));
    summary.push({ sheet: d.sheet, rows: rows.length, note: "" });
  }
  d.headers.forEach((h, i) => { ws.getColumn(i + 1).width = Math.max(h.length + 4, 26); });
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

const stamp = new Date().toISOString().slice(0, 10);
const out = path.resolve(process.cwd(), `pre_migration_backup_${stamp}.xlsx`);
await wb.xlsx.writeFile(out);
await prisma.$disconnect();

console.log("Saved:", out);
for (const s of summary) console.log(` ${s.sheet}: ${s.rows} rows${s.note ? ` — ${s.note}` : ""}`);
