-- Full current schema of Colibri (PostgreSQL >= 14). Creates a fresh database.
-- Built from migrations 001 to 005: any new migration must also be reported here (see migrations/README.md).

-- =====================================================================
-- Gestion des charges locatives – schéma PostgreSQL (≥ 14)
-- Conventions :
--   * toutes les périodes sont des daterange semi-ouverts '[debut, fin+1)'
--     (une ligne « du 01/01 au 31/01 » est stockée '[2025-01-01,2025-02-01)')
--   * montants : numeric, jamais de float ; on arrondit uniquement à l'affichage
--   * un séjour en cours a une borne supérieure infinie (upper(periode) IS NULL)
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE energy AS ENUM ('gas', 'electricity', 'water', 'household_waste', 'other');
CREATE TYPE line_category AS ENUM ('consumption', 'subscription', 'tax', 'service', 'penalty', 'other');
-- remplacee : une facture validée n'est jamais modifiée, elle est remplacée (ADR 0017)
CREATE TYPE invoice_status AS ENUM ('draft', 'validated', 'replaced');
-- ADR 0013 : récupérable (réparti), à la charge du propriétaire (pénalités, taxe foncière hors TEOM : synthèse fiscale),
-- hors immeuble (concerne un autre bien : ni réparti, ni dans la synthèse fiscale de l'immeuble)
CREATE TYPE line_allocation AS ENUM ('recoverable', 'owner', 'outside_building');
-- Decision of the owner on a sent regularisation (ADR 0010); its state (draft, waiting, settled) is computed
CREATE TYPE adjustment_decision AS ENUM ('written_off', 'unrecoverable');

-- ---------------------------------------------------------------- référentiel
CREATE TABLE building (
  id          serial PRIMARY KEY,
  code        text NOT NULL UNIQUE,              -- court et unique : 'IMM1', 'MAISON'…
  name         text NOT NULL,
  address     text,
  -- ADR 0023 : début de la gestion dans l'application (avant : une agence, ou rien) ; facultatif
  managed_from date
);

CREATE TABLE unit (
  id          serial PRIMARY KEY,
  building_id int  NOT NULL REFERENCES building(id),
  code        text NOT NULL,                     -- 'Lot 1'
  label text,
  area_m2  numeric(7,2),
  charge_shares   int  NOT NULL CHECK (charge_shares > 0),
  UNIQUE (building_id, code)
);

CREATE TABLE tenant (
  id          serial PRIMARY KEY,
  name         text NOT NULL UNIQUE,
  email       text,
  phone   text,
  note        text
);

-- Un séjour = un locataire dans un lot sur une période (entrée → sortie incluses).
CREATE TABLE tenancy (
  id           serial PRIMARY KEY,
  unit_id       int  NOT NULL REFERENCES unit(id),
  tenant_id int  NOT NULL REFERENCES tenant(id),
  period      daterange NOT NULL CHECK (NOT isempty(period) AND lower(period) IS NOT NULL),
  note         text,
  -- dépôt de garantie prévu au bail (ADR 0008) ; versé, rendu : versement_depot ; conservé : paiements « depot » (ADR 0021)
  security_deposit        numeric(12,2),
  -- deux séjours ne peuvent pas se chevaucher sur le même lot
  EXCLUDE USING gist (unit_id WITH =, period WITH &&)
);

-- ---------------------------------------------------------------- factures
CREATE TABLE supplier (
  id   serial PRIMARY KEY,
  name  text NOT NULL UNIQUE,                     -- 'EDF', 'ENGIE', 'SEAFF', 'DGFiP (taxe foncière)'
  -- ADR 0014 : factures jamais jointes au justificatif (données fiscales, autres biens), « consultable sur demande »
  confidential boolean NOT NULL DEFAULT false,
  -- ADR 0025 : zones masquées sur ses scans, tracées à la main : [{ page, x0, y0, x1, y1 }] (fractions de la page)
  masked_zones jsonb NOT NULL DEFAULT '[]'
);

-- ADR 0013 : extracteurs de factures, code TypeScript écrit dans l'application et exécuté dans le navigateur ;
-- jamais modifiés ni supprimés : corriger un extracteur, c'est créer la version suivante. ADR 0018 : extracteurs de
-- relevés bancaires (type releve, sans énergie), même principe.
CREATE TYPE extractor_type AS ENUM ('invoice', 'bank_statement');
CREATE TABLE extractor (
  id             serial PRIMARY KEY,
  supplier_id int  NOT NULL REFERENCES supplier(id),
  version        int  NOT NULL CHECK (version > 0),
  type           extractor_type NOT NULL DEFAULT 'invoice',
  energy        energy,
  settings       jsonb NOT NULL,                  -- regroupement des morceaux en lignes, toujours écrit
  source         text NOT NULL,                   -- TypeScript, tel qu'édité
  code           text NOT NULL,                   -- JavaScript produit, celui qui s'exécute
  engine         int  NOT NULL,                   -- version du contrat (pdf.js, aides)
  note           text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, version),
  CONSTRAINT extractor_energy CHECK ((type = 'invoice') = (energy IS NOT NULL))
);

CREATE FUNCTION extractor_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Un extracteur n''est jamais modifié ni supprimé : créer une nouvelle version (ADR 0013)';
END $$;
CREATE TRIGGER extractor_frozen BEFORE UPDATE OR DELETE ON extractor
  FOR EACH ROW EXECUTE FUNCTION extractor_frozen();

-- ---------------------------------------------------------------- relevés bancaires (ADR 0018)
-- Un relevé de la banque (fournisseur), lu par un extracteur ; ses mouvements : crédit positif, débit négatif, chacun
-- avec une catégorie.
CREATE TABLE bank_statement (
  id               serial PRIMARY KEY,
  supplier_id   int  NOT NULL REFERENCES supplier(id),
  account           text NOT NULL,
  statement_date      date NOT NULL,
  previous_balance  numeric(14,2) NOT NULL,
  new_balance    numeric(14,2) NOT NULL,
  pdf_file      text,                            -- chemin dans le stockage : releves/<empreinte>.pdf
  extractor_id    int REFERENCES extractor(id),
  imported_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account, statement_date)
);

CREATE TABLE bank_transaction (
  id              serial PRIMARY KEY,
  bank_statement_id       int  NOT NULL REFERENCES bank_statement(id) ON DELETE CASCADE,
  position           int  NOT NULL,
  transaction_date  date NOT NULL,
  value_date     date,
  label         text NOT NULL,
  detail          text,
  amount         numeric(12,2) NOT NULL CHECK (amount <> 0),
  -- Ce qu'est le mouvement : paiement d'un locataire, travaux et dépôt de garantie ont un détail
  -- (paiement.mouvement_id, reglement_travaux.mouvement_id, versement_depot.mouvement_id ; reglement_facture, facultatif) qui doit couvrir le montant ;
  -- « agence » : loyers reversés par une agence de gestion, sans détail (ADR 0018, 0019)
  category       text CONSTRAINT bank_transaction_category_check CHECK (category IN ('tenant', 'works',
    'security_deposit', 'agency', 'loan', 'insurance', 'energy', 'water', 'taxes', 'bank_fees', 'co_ownership',
    'fees', 'partners', 'internal_transfer', 'other')),
  note            text,
  CONSTRAINT bank_transaction_other_has_note CHECK (category IS DISTINCT FROM 'other' OR note IS NOT NULL)
);
CREATE INDEX ON bank_transaction (transaction_date);

CREATE TABLE invoice (
  id             serial PRIMARY KEY,
  building_id    int  NOT NULL REFERENCES building(id),
  supplier_id int  NOT NULL REFERENCES supplier(id),
  energy        energy NOT NULL,
  number         text NOT NULL,
  invoice_date   date,
  total_incl_tax    numeric(12,2),                   -- total imprimé (contrôle) ; vide sur un brouillon s'il est à saisir
  pdf_file    text,                            -- PDF archivé : factures/<empreinte>.pdf
  status         invoice_status NOT NULL DEFAULT 'draft',
  note           text,
  extractor_id  int REFERENCES extractor(id),   -- version qui a lu la facture (vide : saisie à la main)
  -- ADR 0017 : facture remplacée (par qui, quand, pourquoi) ; brouillon d'une correction : la facture qu'il remplacera
  replaced_by      int REFERENCES invoice(id),
  replaced_at       timestamptz,
  replacement_reason text,
  replaces_id        int REFERENCES invoice(id),
  CONSTRAINT invoice_validated_has_total CHECK (status <> 'validated' OR total_incl_tax IS NOT NULL),
  CONSTRAINT invoice_replaced CHECK (
    (status = 'replaced') = (replaced_by IS NOT NULL AND replaced_at IS NOT NULL AND replacement_reason IS NOT NULL)),
  CONSTRAINT invoice_not_itself CHECK (replaced_by <> id AND replaces_id <> id)
);
-- Numéro unique chez un fournisseur parmi les factures validées : le brouillon d'une correction garde le numéro
CREATE UNIQUE INDEX invoice_number_validated ON invoice (supplier_id, number) WHERE status = 'validated';

-- ADR 0024 : factures jointes en images, caviardées ; termes masqués sur toutes les factures
CREATE TABLE masked_term (
  term text PRIMARY KEY CHECK (length(trim(term)) > 0)
);

CREATE TABLE invoice_tenant_copy (
  id             serial PRIMARY KEY,
  invoice_id     int  NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  pdf_file    text NOT NULL,                   -- version en images : annexes/<empreinte>.pdf
  source_pdf     text NOT NULL,                   -- PDF de la facture dont elle est faite (à refaire s'il change)
  zones          jsonb NOT NULL,                  -- rectangles peints : page, x0, y0, x1, y1 (fractions), origine
  extractor_id  int REFERENCES extractor(id),   -- version qui a donné les règles (vide : termes seuls)
  terms         text[] NOT NULL,                 -- termes masqués du moment
  settings       jsonb NOT NULL,                  -- dpi, seuil
  created_at        timestamptz NOT NULL DEFAULT now(),
  checked_at    timestamptz,
  scanned_pages int[] NOT NULL DEFAULT '{}'      -- ADR 0025 : pages qui étaient des scans (masquées par zones seules)
);
CREATE INDEX ON invoice_tenant_copy (invoice_id);

CREATE FUNCTION tenant_copy_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.checked_at IS NULL AND NEW.checked_at IS NOT NULL
     AND (to_jsonb(NEW) - 'checked_at') = (to_jsonb(OLD) - 'checked_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Une annexe n''est jamais modifiée : la refaire (ADR 0024)';
END $$;
CREATE TRIGGER tenant_copy_frozen BEFORE UPDATE ON invoice_tenant_copy
  FOR EACH ROW EXECUTE FUNCTION tenant_copy_frozen();

ALTER TABLE invoice ADD COLUMN tenant_copy_id int REFERENCES invoice_tenant_copy(id);
-- ADR 0025 : zones de ses scans ajustées à la main ; NULL : celles de son fournisseur
ALTER TABLE invoice ADD COLUMN masked_zones jsonb;

CREATE TABLE invoice_line (
  id           serial PRIMARY KEY,
  invoice_id   int  NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  position        int  NOT NULL DEFAULT 0,
  category    line_category NOT NULL,
  label      text NOT NULL,
  period      daterange NOT NULL CHECK (NOT isempty(period) AND NOT lower_inf(period) AND NOT upper_inf(period)),
  kwh          numeric(12,3),
  amount_excl_tax   numeric(12,3),
  vat_rate     numeric(5,4),                      -- 0.2000, 0.0550
  amount_incl_tax  numeric(12,3) NOT NULL,            -- montant réparti (3 décimales : certaines lignes ENGIE en ont 3)
  allocation  line_allocation NOT NULL DEFAULT 'recoverable',
  note         text
);
CREATE INDEX ON invoice_line USING gist (period);

-- Contrôle : somme des lignes vs total imprimé (tolérance 0,05 € pour les arrondis de TVA du fournisseur)
CREATE VIEW v_invoice_check AS
SELECT i.id, i.number, i.energy, i.total_incl_tax,
       coalesce(sum(l.amount_incl_tax), 0)                            AS lines_total,
       i.total_incl_tax - coalesce(sum(l.amount_incl_tax), 0)         AS gap,
       abs(i.total_incl_tax - coalesce(sum(l.amount_incl_tax), 0)) <= 0.05 AS ok
FROM invoice i LEFT JOIN invoice_line l ON l.invoice_id = i.id
GROUP BY i.id;

-- ---------------------------------------------------------------- argent des locataires
-- Provisions versées, par séjour et par année civile (comme le classeur).
-- Phase 4 : remplacer/compléter par une table des paiements reçus (loyer + charges, date, mode).
CREATE TABLE annual_charge_advance (
  id         serial PRIMARY KEY,
  tenancy_id  int NOT NULL REFERENCES tenancy(id),
  year      int NOT NULL,
  amount    numeric(12,2) NOT NULL,
  note       text,
  UNIQUE (tenancy_id, year)
);

-- Régularisations envoyées et leur suivi (sert aussi au calcul des pertes fiscales).
CREATE TABLE charge_adjustment (
  id             serial PRIMARY KEY,
  tenancy_id      int  NOT NULL REFERENCES tenancy(id),
  period       daterange NOT NULL,
  amount_due     numeric(12,2) NOT NULL,          -- quote-part de charges
  advances     numeric(12,2) NOT NULL,
  balance          numeric(12,2) GENERATED ALWAYS AS (amount_due - advances) STORED,
  sent_on     date,                               -- NULL : brouillon (état calculé, ADR 0010)
  decision       adjustment_decision,                     -- charge abandonnée ou irrécouvrable, choisie par le propriétaire
  replaces_id    int REFERENCES charge_adjustment(id),  -- rectificatif d'une régularisation précédente
  note           text,
  snapshot     jsonb,                              -- ce qui a été envoyé, figé (NULL : saisie manuelle), ADR 0007
  sent_tenant_copies jsonb,                            -- annexe jointe par facture à l'envoi (ADR 0024)
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT charge_adjustment_decision_sent CHECK (decision IS NULL OR sent_on IS NOT NULL)
);

-- Payments received from tenants (ADR 0008): rent and provision of a month, and/or an amount toward a
-- regularisation (negative: refund paid by the owner). One row per payment received (a bank transfer, a cheque).
CREATE TABLE payment (
  id                 serial PRIMARY KEY,
  tenancy_id          int  NOT NULL REFERENCES tenancy(id),
  payment_date      date NOT NULL,
  month               date CHECK (month IS NULL OR extract(day FROM month) = 1),  -- month of rent covered (1st day)
  rent              numeric(12,2) NOT NULL DEFAULT 0,
  charge_advance          numeric(12,2) NOT NULL DEFAULT 0,                         -- provision sur charges
  charge_adjustment_id  int REFERENCES charge_adjustment(id),
  charge_adjustment     numeric(12,2) NOT NULL DEFAULT 0,
  -- « depot » : retenue sur le dépôt de garantie (ADR 0021), jamais rattachée à un mouvement bancaire
  method               text CONSTRAINT payment_method_check
                       CHECK (method IN ('transfer', 'direct_debit', 'cheque', 'cash', 'other', 'deposit')),
  note               text,
  bank_transaction_id       int REFERENCES bank_transaction(id) ON DELETE SET NULL,   -- mouvement du relevé bancaire (ADR 0018)
  CHECK (month IS NOT NULL OR (rent = 0 AND charge_advance = 0)),
  CHECK (charge_adjustment_id IS NOT NULL OR charge_adjustment = 0),
  CONSTRAINT payment_deposit_without_transaction CHECK (method IS DISTINCT FROM 'deposit' OR bank_transaction_id IS NULL)
);
CREATE INDEX ON payment (tenancy_id, month);
CREATE INDEX ON payment (charge_adjustment_id);
CREATE INDEX ON payment (bank_transaction_id);

-- Deposits (ADR 0019): what a tenant paid (positive) and what was refunded to them (negative), each seen on a bank
-- statement when linked; what the owner holds is their sum. sejour.depot_garantie stays the amount of the lease.
CREATE TABLE deposit_payment (
  id              serial PRIMARY KEY,
  tenancy_id       int  NOT NULL REFERENCES tenancy(id),
  payment_date  date NOT NULL,
  amount         numeric(12,2) NOT NULL CHECK (amount <> 0),
  bank_transaction_id    int REFERENCES bank_transaction(id) ON DELETE SET NULL,
  note            text
);
CREATE INDEX ON deposit_payment (tenancy_id);
CREATE INDEX ON deposit_payment (bank_transaction_id);

-- Rent and provision called each month from a given month on, until the next row of the stay (ADR 0009: revision of
-- the rent, new provision after a regularisation). A month of presence that is not complete is called pro rata of its
-- days.
CREATE TABLE rent_schedule (
  id          serial PRIMARY KEY,
  tenancy_id   int  NOT NULL REFERENCES tenancy(id) ON DELETE CASCADE,
  from_month date NOT NULL CHECK (extract(day FROM from_month) = 1),  -- first month concerned (1st day)
  rent       numeric(12,2) NOT NULL CHECK (rent >= 0),
  charge_advance   numeric(12,2) NOT NULL CHECK (charge_advance >= 0),           -- provision sur charges
  note        text,
  UNIQUE (tenancy_id, from_month)
);

-- Provisions per stay and calendar year (SPEC R9): the sum of the monthly payments when the year has any,
-- otherwise the yearly total entered by hand (history before monthly payments).
CREATE VIEW v_charge_advance AS
WITH paid AS (
  SELECT tenancy_id, extract(year FROM month)::int AS year, sum(charge_advance) AS amount
  FROM payment WHERE month IS NOT NULL GROUP BY 1, 2
)
SELECT p.tenancy_id, p.year, p.amount, 'payments'::text AS source FROM paid p
UNION ALL
SELECT a.tenancy_id, a.year, a.amount, 'entered' FROM annual_charge_advance a
WHERE NOT EXISTS (SELECT 1 FROM paid p WHERE p.tenancy_id = a.tenancy_id AND p.year = a.year);

-- Amount paid toward a regularisation, including the payments made on the ones it replaces (corrective chain)
CREATE FUNCTION charge_adjustment_paid(p_id int) RETURNS numeric
LANGUAGE sql STABLE AS $$
WITH RECURSIVE chain AS (
  SELECT id, replaces_id FROM charge_adjustment WHERE id = p_id
  UNION ALL
  SELECT c.id, c.replaces_id FROM charge_adjustment c JOIN chain ch ON c.id = ch.replaces_id
)
SELECT coalesce(sum(p.charge_adjustment), 0) FROM payment p WHERE p.charge_adjustment_id IN (SELECT id FROM chain)
$$;

-- State of a regularisation (ADR 0010): brouillon (not sent), soldee (paid within 1 euro, corrective chain included:
-- the legacy workbook rounds), en_attente (sent, still to be paid or refunded)
CREATE FUNCTION charge_adjustment_state(p_id int) RETURNS text
LANGUAGE sql STABLE AS $$
SELECT CASE WHEN c.sent_on IS NULL THEN 'draft'
            WHEN abs(c.balance - charge_adjustment_paid(c.id)) < 1 THEN 'settled'
            ELSE 'pending' END
FROM charge_adjustment c WHERE c.id = p_id
$$;

-- Date of the last payment of a settled regularisation (corrective chain included), else null
CREATE FUNCTION charge_adjustment_settled_on(p_id int) RETURNS date
LANGUAGE sql STABLE AS $$
WITH RECURSIVE chain AS (
  SELECT id, replaces_id FROM charge_adjustment WHERE id = p_id
  UNION ALL
  SELECT c.id, c.replaces_id FROM charge_adjustment c JOIN chain ch ON c.id = ch.replaces_id
)
SELECT CASE WHEN charge_adjustment_state(p_id) = 'settled'
            THEN (SELECT max(p.payment_date) FROM payment p WHERE p.charge_adjustment_id IN (SELECT id FROM chain)) END
$$;

-- ---------------------------------------------------------------- compteurs d'eau (phase ultérieure)
-- ADR 0015 : travaux payés par le propriétaire, pour la déclaration seulement (jamais répartis) ; déductibles
-- (2044, ligne 224) selon leur nature : entretien et amélioration oui, construction et agrandissement non.
CREATE TYPE works_nature AS ENUM ('maintenance', 'improvement', 'construction');

CREATE TABLE works_invoice (
  id             serial PRIMARY KEY,
  building_id    int  NOT NULL REFERENCES building(id),
  unit_id         int  REFERENCES unit(id),                -- vide : travaux de l'immeuble ou des parties communes
  supplier    text NOT NULL,
  description    text NOT NULL,
  nature         works_nature NOT NULL,
  invoice_date   date NOT NULL,
  total_incl_tax    numeric(12,2) NOT NULL,
  pdf_file    text,                                   -- PDF archivé : travaux/<empreinte>.pdf
  note           text
);
CREATE INDEX ON works_invoice (building_id, invoice_date);

-- ADR 0019 : une facture de travaux est payée par des mouvements bancaires seulement (payé = vu à la banque), un ou
-- plusieurs (acompte, solde), chacun pour un montant ; l'année fiscale de chacun est celle de son mouvement
CREATE TABLE works_invoice_payment (
  id             serial PRIMARY KEY,
  works_invoice_id     int NOT NULL REFERENCES works_invoice(id) ON DELETE CASCADE,
  bank_transaction_id   int NOT NULL REFERENCES bank_transaction(id) ON DELETE CASCADE,
  amount        numeric(12,2) NOT NULL CHECK (amount > 0),
  UNIQUE (works_invoice_id, bank_transaction_id)
);
CREATE INDEX ON works_invoice_payment (bank_transaction_id);

-- ADR 0022 : les factures des charges (gaz, électricité, eau, taxe foncière) réglées par des mouvements bancaires, comme
-- les travaux : un ou plusieurs règlements ; leur total ne dépasse ni la facture ni le mouvement ; un crédit qui
-- rembourse la facture (mensualités supérieures à la facture annuelle) est un règlement négatif
CREATE TABLE invoice_payment (
  id             serial PRIMARY KEY,
  invoice_id     int NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  bank_transaction_id   int NOT NULL REFERENCES bank_transaction(id) ON DELETE CASCADE,
  amount        numeric(12,2) NOT NULL CONSTRAINT invoice_payment_amount_check CHECK (amount <> 0),
  UNIQUE (invoice_id, bank_transaction_id)
);
CREATE INDEX ON invoice_payment (bank_transaction_id);

-- ADR 0016 : la société (SCI), ses associés et leurs parts, ses assemblées générales et leurs procès-verbaux ;
-- une assemblée close est numérotée dans le registre et figée.
CREATE TABLE company (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name  text NOT NULL,
  legal_form         text NOT NULL DEFAULT 'SCI',
  capital       numeric(14,2),
  registered_office         text,
  rcs           text
);

CREATE TABLE partner (
  id       serial PRIMARY KEY,
  name      text NOT NULL,
  shares    int  NOT NULL CHECK (shares > 0),
  manager   boolean NOT NULL DEFAULT false,
  address  text,
  note     text
);

CREATE TYPE meeting_type AS ENUM ('ordinary', 'extraordinary');
CREATE TYPE meeting_status AS ENUM ('draft', 'closed');
CREATE TYPE attendance_status AS ENUM ('present', 'represented', 'absent');

CREATE TABLE general_meeting (
  id             serial PRIMARY KEY,
  number         int UNIQUE,
  type           meeting_type NOT NULL,
  date           date NOT NULL,
  time          text,
  place           text,
  agenda  text NOT NULL DEFAULT '',
  chair      text,
  remarks   text,
  status         meeting_status NOT NULL DEFAULT 'draft',
  closed_at       timestamptz,
  snapshot     jsonb,
  signed_minutes       text,
  CONSTRAINT general_meeting_closed CHECK (status = 'draft' OR (number IS NOT NULL AND snapshot IS NOT NULL))
);

CREATE TABLE attendance (
  general_meeting_id    int NOT NULL REFERENCES general_meeting(id) ON DELETE CASCADE,
  partner_id      int NOT NULL REFERENCES partner(id),
  status          attendance_status NOT NULL DEFAULT 'present',
  represented_by  text,
  PRIMARY KEY (general_meeting_id, partner_id)
);

CREATE TABLE resolution (
  id            serial PRIMARY KEY,
  general_meeting_id  int NOT NULL REFERENCES general_meeting(id) ON DELETE CASCADE,
  position         int NOT NULL,
  title         text NOT NULL,
  text         text NOT NULL DEFAULT '',
  votes_for          int  NOT NULL DEFAULT 0 CHECK (votes_for >= 0),
  votes_against        int  NOT NULL DEFAULT 0 CHECK (votes_against >= 0),
  abstentions    int  NOT NULL DEFAULT 0 CHECK (abstentions >= 0)
);

-- A closed meeting: only its signed minutes may still be attached or replaced
CREATE FUNCTION general_meeting_closed_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Assemblée close : elle n''est jamais supprimée (registre, ADR 0016)';
  END IF;
  IF (to_jsonb(NEW) - 'signed_minutes') <> (to_jsonb(OLD) - 'signed_minutes') THEN
    RAISE EXCEPTION 'Assemblée close : elle n''est plus modifiée (registre, ADR 0016)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER general_meeting_closed_frozen BEFORE UPDATE OR DELETE ON general_meeting
  FOR EACH ROW WHEN (OLD.status = 'closed') EXECUTE FUNCTION general_meeting_closed_frozen();

CREATE FUNCTION general_meeting_detail_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM general_meeting
             WHERE id = coalesce(NEW.general_meeting_id, OLD.general_meeting_id) AND status = 'closed') THEN
    RAISE EXCEPTION 'Assemblée close : ses présences et résolutions ne changent plus (registre, ADR 0016)';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER attendance_frozen BEFORE INSERT OR UPDATE OR DELETE ON attendance
  FOR EACH ROW EXECUTE FUNCTION general_meeting_detail_frozen();
CREATE TRIGGER resolution_frozen BEFORE INSERT OR UPDATE OR DELETE ON resolution
  FOR EACH ROW EXECUTE FUNCTION general_meeting_detail_frozen();

-- =====================================================================
-- Moteur de répartition
--   part = TTC × jours(ligne ∩ séjour ∩ exercice) ÷ jours(ligne) × tantièmes du lot ÷ total tantièmes
--   la part des jours sans locataire reste au propriétaire (sejour_id NULL)
-- Les bornes p_debut / p_fin de l'exercice sont INCLUSES.
-- =====================================================================

CREATE FUNCTION day_count(r daterange) RETURNS int
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN isempty(r) THEN 0 ELSE upper(r) - lower(r) END $$;

-- Each recoverable line of the validated invoices of a building, apportioned to the tenancies of a period by days and
-- charge shares; the rest (empty units) with tenancy_id NULL
CREATE FUNCTION apportionment(p_building int, p_start date, p_end date)
RETURNS TABLE (invoice_line_id int, invoice_id int, energy energy, category line_category,
               tenancy_id int, days int, amount numeric)
LANGUAGE sql STABLE AS $$
WITH per AS (SELECT daterange(p_start, p_end + 1) AS r),
tot AS (SELECT sum(charge_shares)::numeric AS t FROM unit WHERE building_id = p_building),
lin AS (
  SELECT l.id, l.invoice_id, i.energy, l.category, l.amount_incl_tax,
         day_count(l.period) AS n, l.period * per.r AS pe
  FROM invoice_line l
  JOIN invoice i ON i.id = l.invoice_id AND i.building_id = p_building AND i.status = 'validated'
  CROSS JOIN per
  WHERE l.allocation = 'recoverable' AND l.period && per.r
),
parts AS (
  SELECT lin.id, lin.invoice_id, lin.energy, lin.category, t.id AS tenancy_id,
         day_count(lin.pe * t.period) AS days,
         lin.amount_incl_tax * day_count(lin.pe * t.period) / lin.n * u.charge_shares / tot.t AS amount
  FROM lin
  JOIN tenancy t ON t.period && lin.pe
  JOIN unit u ON u.id = t.unit_id AND u.building_id = p_building
  CROSS JOIN tot
)
SELECT id, invoice_id, energy, category, tenancy_id, days, amount FROM parts
UNION ALL
SELECT lin.id, lin.invoice_id, lin.energy, lin.category, NULL, day_count(lin.pe),
       lin.amount_incl_tax * day_count(lin.pe) / lin.n
         - coalesce((SELECT sum(p.amount) FROM parts p WHERE p.id = lin.id), 0)
FROM lin
$$;

CREATE FUNCTION charge_statement(p_building int, p_start date, p_end date)
RETURNS TABLE (tenancy_id int, tenant text, unit text, charge_shares int, present daterange, days int,
               gas_consumption numeric, gas_other numeric,
               electricity_consumption numeric, electricity_other numeric,
               water numeric, household_waste numeric,
               total numeric, advances numeric, balance numeric)
LANGUAGE sql STABLE AS $$
WITH r AS (SELECT * FROM apportionment(p_building, p_start, p_end) WHERE tenancy_id IS NOT NULL),
agg AS (
  SELECT r.tenancy_id,
    coalesce(sum(amount) FILTER (WHERE energy = 'gas' AND category = 'consumption'), 0)           AS gc,
    coalesce(sum(amount) FILTER (WHERE energy = 'gas' AND category <> 'consumption'), 0)          AS go,
    coalesce(sum(amount) FILTER (WHERE energy = 'electricity' AND category = 'consumption'), 0)   AS ec,
    coalesce(sum(amount) FILTER (WHERE energy = 'electricity' AND category <> 'consumption'), 0)  AS eo,
    coalesce(sum(amount) FILTER (WHERE energy = 'water'), 0)                                      AS wa,
    coalesce(sum(amount) FILTER (WHERE energy = 'household_waste'), 0)                            AS hw
  FROM r GROUP BY r.tenancy_id
),
adv AS (
  SELECT a.tenancy_id, sum(a.amount) AS m FROM v_charge_advance a
  WHERE a.year BETWEEN extract(year FROM p_start) AND extract(year FROM p_end)
  GROUP BY a.tenancy_id
)
SELECT t.id, te.name, u.code, u.charge_shares,
       t.period * daterange(p_start, p_end + 1),
       day_count(t.period * daterange(p_start, p_end + 1)),
       coalesce(a.gc, 0), coalesce(a.go, 0), coalesce(a.ec, 0), coalesce(a.eo, 0),
       coalesce(a.wa, 0), coalesce(a.hw, 0),
       coalesce(a.gc + a.go + a.ec + a.eo + a.wa + a.hw, 0),
       coalesce(v.m, 0),
       coalesce(a.gc + a.go + a.ec + a.eo + a.wa + a.hw, 0) - coalesce(v.m, 0)
FROM tenancy t
JOIN unit u ON u.id = t.unit_id AND u.building_id = p_building
JOIN tenant te ON te.id = t.tenant_id
LEFT JOIN agg a ON a.tenancy_id = t.id
LEFT JOIN adv v ON v.tenancy_id = t.id
WHERE t.period && daterange(p_start, p_end + 1) OR v.m IS NOT NULL
ORDER BY u.code, lower(t.period)
$$;

CREATE FUNCTION summary(p_building int, p_start date, p_end date)
RETURNS TABLE (energy energy, invoices numeric, tenants numeric, owner numeric)
LANGUAGE sql STABLE AS $$
SELECT energy,
       sum(amount),
       coalesce(sum(amount) FILTER (WHERE tenancy_id IS NOT NULL), 0),
       coalesce(sum(amount) FILTER (WHERE tenancy_id IS NULL), 0)
FROM apportionment(p_building, p_start, p_end)
GROUP BY energy ORDER BY energy
$$;

-- ---------------------------------------------------------------- authentification
-- ADR 0020 : connexion par passkey (WebAuthn) seulement ; seules les empreintes (SHA-256) des secrets sont gardées
CREATE TABLE app_user (
  id       serial PRIMARY KEY,
  email    text NOT NULL UNIQUE,
  name      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE passkey (
  id              text PRIMARY KEY,                     -- credential id (base64url)
  app_user_id  int  NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  public_key    bytea NOT NULL,
  sign_count        bigint NOT NULL DEFAULT 0,
  transports      text[],
  device        text NOT NULL,                        -- name given at registration (« MacBook », « iPhone »)
  created_at         timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz
);
CREATE INDEX ON passkey (app_user_id);

CREATE TABLE session (
  token_hash       text PRIMARY KEY,                     -- SHA-256 of the cookie
  app_user_id  int  NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);
CREATE INDEX ON session (app_user_id);

CREATE TABLE registration_link (
  token_hash       text PRIMARY KEY,                     -- SHA-256 of the link's token
  app_user_id  int  NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  expires_at       timestamptz NOT NULL,
  used_at      timestamptz
);

CREATE TABLE api_token (
  id              serial PRIMARY KEY,
  name             text NOT NULL,
  token_hash       text NOT NULL UNIQUE,                 -- SHA-256 of the token
  app_user_id  int  NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  used_at      timestamptz,
  revoked_at      timestamptz
);
