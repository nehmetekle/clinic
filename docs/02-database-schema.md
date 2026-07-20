# NutriClinic — Database Schema

PostgreSQL. UUID primary keys, `created_at`/`updated_at` on all tables, soft-delete
via `status` where it matters. Money stored as `NUMERIC(12,2)` (never floats).
Times stored in UTC; rendered in clinic timezone.

## Entity relationships (text ERD)

```
users 1──* clients            (created_by, assigned_dietitian_id)
users 1──* appointments       (dietitian_id, created_by)
users 1──* consultations      (dietitian_id)
users 1──* payments/expenses  (created_by)
clients 1──* client_packages
clients 1──* appointments
clients 1──* consultations
clients 1──* payments
packages 1──* client_packages
client_packages 1──* payments           (a payment can settle a package)
appointments 1──1 consultations         (a visit produces one consultation)
* tables ──* audit_logs                  (polymorphic via entity_type/entity_id)
```

---

## DDL

```sql
-- ─── Enums ──────────────────────────────────────────────────────────────
CREATE TYPE user_role        AS ENUM ('admin', 'dietitian', 'secretary');
CREATE TYPE user_status      AS ENUM ('active', 'inactive');
CREATE TYPE client_status    AS ENUM ('active', 'inactive', 'completed', 'cancelled');
CREATE TYPE gender_type      AS ENUM ('male', 'female', 'other', 'unspecified');
CREATE TYPE pkg_status       AS ENUM ('active', 'inactive');
CREATE TYPE client_pkg_status AS ENUM ('active', 'completed', 'expired', 'cancelled');
CREATE TYPE pay_status       AS ENUM ('paid', 'partially_paid', 'unpaid');
CREATE TYPE pay_method       AS ENUM ('cash', 'card', 'bank_transfer', 'online', 'other');
CREATE TYPE appt_status      AS ENUM ('scheduled','checked_in','waiting','with_dietitian','completed','cancelled','no_show');
CREATE TYPE visit_type       AS ENUM ('initial', 'follow_up', 'measurement', 'other');

-- ─── 1. Users (staff) ───────────────────────────────────────────────────
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name       TEXT        NOT NULL,
  username        TEXT        UNIQUE,
  email           TEXT        UNIQUE NOT NULL,
  password_hash   TEXT        NOT NULL,
  role            user_role   NOT NULL,
  phone           TEXT,
  status          user_status NOT NULL DEFAULT 'active',
  permissions     JSONB       NOT NULL DEFAULT '{}',  -- per-user overrides
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 2. Clients ─────────────────────────────────────────────────────────
CREATE TABLE clients (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name            TEXT NOT NULL,
  last_name             TEXT NOT NULL,
  phone                 TEXT NOT NULL,
  email                 TEXT,
  date_of_birth         DATE,
  gender                gender_type DEFAULT 'unspecified',
  address               TEXT,
  emergency_contact     TEXT,
  medical_notes         TEXT,        -- sensitive
  allergies             TEXT,        -- sensitive
  status                client_status NOT NULL DEFAULT 'active',
  assigned_dietitian_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_clients_name   ON clients (last_name, first_name);
CREATE INDEX idx_clients_phone  ON clients (phone);
CREATE INDEX idx_clients_status ON clients (status);
CREATE INDEX idx_clients_dietitian ON clients (assigned_dietitian_id);
-- Trigram search (name/phone/email)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_clients_search ON clients USING gin (
  (first_name || ' ' || last_name || ' ' || phone || ' ' || coalesce(email,'')) gin_trgm_ops
);

-- ─── 3. Packages (catalog) ──────────────────────────────────────────────
CREATE TABLE packages (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL,
  description        TEXT,
  price              NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  number_of_sessions INT  NOT NULL CHECK (number_of_sessions >= 0),
  duration_days      INT,                       -- validity window; NULL = no expiry
  discount_percent   NUMERIC(5,2) DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  status             pkg_status NOT NULL DEFAULT 'active',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 4. Client packages (purchased instances) ───────────────────────────
CREATE TABLE client_packages (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  package_id         UUID REFERENCES packages(id) ON DELETE SET NULL,
  package_name       TEXT NOT NULL,             -- snapshot at purchase
  price              NUMERIC(12,2) NOT NULL,    -- snapshot (after discount)
  total_sessions     INT  NOT NULL,
  used_sessions      INT  NOT NULL DEFAULT 0,
  remaining_sessions INT  GENERATED ALWAYS AS (total_sessions - used_sessions) STORED,
  start_date         DATE NOT NULL DEFAULT CURRENT_DATE,
  expiration_date    DATE,
  payment_status     pay_status NOT NULL DEFAULT 'unpaid',
  status             client_pkg_status NOT NULL DEFAULT 'active',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT used_not_over CHECK (used_sessions <= total_sessions)
);
CREATE INDEX idx_cpkg_client ON client_packages (client_id);
CREATE INDEX idx_cpkg_status ON client_packages (status, payment_status);

-- ─── 5. Appointments ────────────────────────────────────────────────────
CREATE TABLE appointments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  dietitian_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  client_package_id UUID REFERENCES client_packages(id) ON DELETE SET NULL,
  appointment_date DATE NOT NULL,
  start_time       TIME NOT NULL,
  end_time         TIME,
  status           appt_status NOT NULL DEFAULT 'scheduled',
  visit_type       visit_type  NOT NULL DEFAULT 'follow_up',
  notes            TEXT,
  checked_in_at    TIMESTAMPTZ,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_appt_date      ON appointments (appointment_date, start_time);
CREATE INDEX idx_appt_dietitian ON appointments (dietitian_id, appointment_date);
CREATE INDEX idx_appt_client    ON appointments (client_id);
CREATE INDEX idx_appt_status    ON appointments (status);

-- ─── 6. Consultations (clinical record) ─────────────────────────────────
CREATE TABLE consultations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  dietitian_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  appointment_id      UUID UNIQUE REFERENCES appointments(id) ON DELETE SET NULL,
  client_package_id   UUID REFERENCES client_packages(id) ON DELETE SET NULL,
  consultation_date   TIMESTAMPTZ NOT NULL DEFAULT now(),
  visit_number        INT NOT NULL,
  weight_kg           NUMERIC(5,2),
  height_cm           NUMERIC(5,2),
  bmi                 NUMERIC(5,2),   -- computed app-side on save; stored for history
  waist_cm            NUMERIC(5,2),
  hips_cm             NUMERIC(5,2),
  body_fat_percent    NUMERIC(5,2),
  muscle_mass_kg      NUMERIC(5,2),
  goal_weight_kg      NUMERIC(5,2),
  client_goals        TEXT,
  notes               TEXT,           -- sensitive (clinical)
  recommendations     TEXT,
  follow_up_plan      TEXT,
  next_appointment_date DATE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_consult_client ON consultations (client_id, consultation_date DESC);
CREATE INDEX idx_consult_dietitian ON consultations (dietitian_id);

-- ─── 7. Payments ────────────────────────────────────────────────────────
CREATE TABLE payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  client_package_id UUID REFERENCES client_packages(id) ON DELETE SET NULL,
  package_id        UUID REFERENCES packages(id) ON DELETE SET NULL,
  amount_paid       NUMERIC(12,2) NOT NULL CHECK (amount_paid >= 0),
  total_amount      NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0),
  remaining_balance NUMERIC(12,2) GENERATED ALWAYS AS (total_amount - amount_paid) STORED,
  payment_method    pay_method NOT NULL,
  payment_status    pay_status NOT NULL,
  payment_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  receipt_number    TEXT UNIQUE NOT NULL,        -- e.g. RCP-2026-000123
  notes             TEXT,
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pay_client ON payments (client_id, payment_date DESC);
CREATE INDEX idx_pay_date   ON payments (payment_date);
CREATE INDEX idx_pay_method ON payments (payment_method);

-- ─── 8. Expenses ────────────────────────────────────────────────────────
CREATE TABLE expenses (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title              TEXT NOT NULL,
  amount             NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  category           TEXT NOT NULL,              -- configurable; FK to expense_categories optional
  expense_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  paid_by            TEXT,
  payment_method     pay_method,
  receipt_attachment UUID REFERENCES attachments(id) ON DELETE SET NULL,
  notes              TEXT,
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_exp_date     ON expenses (expense_date);
CREATE INDEX idx_exp_category ON expenses (category);

-- ─── 9. Attachments (files) ─────────────────────────────────────────────
CREATE TABLE attachments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type   TEXT NOT NULL,        -- 'client' | 'consultation' | 'expense'
  owner_id     UUID NOT NULL,
  file_name    TEXT NOT NULL,
  mime_type    TEXT,
  size_bytes   BIGINT,
  storage_key  TEXT NOT NULL,        -- object-storage path
  uploaded_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_attach_owner ON attachments (owner_type, owner_id);

-- ─── 10. Audit logs (append-only) ───────────────────────────────────────
CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,         -- 'client.create','payment.record', ...
  entity_type TEXT NOT NULL,
  entity_id   UUID,
  details     JSONB,                 -- before/after snapshot or diff
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX idx_audit_user   ON audit_logs (user_id, created_at DESC);
CREATE INDEX idx_audit_time   ON audit_logs (created_at DESC);

-- ─── Settings (single-row clinic config) ────────────────────────────────
CREATE TABLE clinic_settings (
  id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  clinic_name     TEXT NOT NULL DEFAULT 'My Clinic',
  currency        TEXT NOT NULL DEFAULT 'USD',
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  receipt_prefix  TEXT NOT NULL DEFAULT 'RCP',
  expense_categories JSONB NOT NULL DEFAULT '["Rent","Utilities","Salaries","Supplies","Marketing","Equipment","Maintenance","Other"]',
  secretary_sees_medical BOOLEAN NOT NULL DEFAULT false,
  inactivity_logout_min  INT NOT NULL DEFAULT 30,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## Key integrity rules (enforced in app/service layer + triggers)

1. **Receipt numbers** generated atomically per year (`RCP-<year>-<6-digit seq>`); never reused.
2. **Session counting:** completing a consultation linked to a `client_package` runs in a transaction → `used_sessions += 1`; guarded by `used_not_over` CHECK. When `remaining_sessions = 0`, set client_package.status = `completed`.
3. **Payment status:** after each payment, recompute the client_package's `payment_status` from Σ(amount_paid) vs `price`.
4. **BMI** computed in the service layer on save (so the rounding rule is centralized) and stored for historical accuracy even if a later edit changes height.
5. **visit_number** = `(SELECT count(*) FROM consultations WHERE client_id = $1) + 1` inside the create transaction.
6. **Expiration:** a nightly job flips `client_packages.status` to `expired` when `expiration_date < today` and sessions remain.
7. **Audit:** writes happen in the same transaction as the mutating action (outbox or trigger) so they can't be skipped.
8. **Soft delete:** clients/packages/users are deactivated (status), not deleted, to preserve referential history and audit trail.

## Reporting helpers (views / materialized views)

```sql
-- Daily money rollup powering admin charts
CREATE VIEW v_daily_finance AS
SELECT d::date AS day,
  (SELECT COALESCE(SUM(amount_paid),0) FROM payments WHERE payment_date = d::date) AS income,
  (SELECT COALESCE(SUM(amount),0)      FROM expenses WHERE expense_date = d::date) AS expenses
FROM generate_series(CURRENT_DATE - INTERVAL '90 days', CURRENT_DATE, '1 day') d;

-- Most profitable packages
CREATE VIEW v_package_revenue AS
SELECT p.id, p.name,
  COUNT(cp.id)                       AS times_sold,
  COALESCE(SUM(pay.amount_paid),0)   AS revenue
FROM packages p
LEFT JOIN client_packages cp ON cp.package_id = p.id
LEFT JOIN payments pay       ON pay.client_package_id = cp.id
GROUP BY p.id, p.name
ORDER BY revenue DESC;

-- Outstanding client balances
CREATE VIEW v_client_balance AS
SELECT c.id, c.first_name, c.last_name,
  COALESCE(SUM(cp.price),0) - COALESCE(SUM(pay.amount_paid),0) AS balance
FROM clients c
LEFT JOIN client_packages cp ON cp.client_id = c.id
LEFT JOIN payments pay       ON pay.client_id = c.id
GROUP BY c.id
HAVING COALESCE(SUM(cp.price),0) - COALESCE(SUM(pay.amount_paid),0) > 0;
```

> Note on your original spec: I split `Packages` into a **catalog** (`packages`) and a
> **purchased instance** (`client_packages`) and snapshot name+price into the instance.
> This is the one schema change that matters — it keeps financial history correct when
> the admin later edits or re-prices a package.
