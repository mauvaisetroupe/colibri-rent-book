-- ADR 0016: the company (SCI), its partners and their shares, its general meetings and their minutes. A meeting is a
-- draft until it is closed: closing gives it the next number of the register and freezes its minutes (instantane);
-- a closed meeting is never changed nor deleted, but for its signed minutes (PDF) attached afterwards.
BEGIN;

CREATE TABLE societe (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  denomination  text NOT NULL,
  forme         text NOT NULL DEFAULT 'SCI',
  capital       numeric(14,2),
  siege         text,
  rcs           text
);

CREATE TABLE associe (
  id       serial PRIMARY KEY,
  nom      text NOT NULL,
  parts    int  NOT NULL CHECK (parts > 0),
  gerant   boolean NOT NULL DEFAULT false,
  adresse  text,
  note     text
);

CREATE TYPE type_assemblee AS ENUM ('ordinaire', 'extraordinaire');
CREATE TYPE statut_assemblee AS ENUM ('brouillon', 'close');
CREATE TYPE presence_associe AS ENUM ('present', 'represente', 'absent');

CREATE TABLE assemblee (
  id             serial PRIMARY KEY,
  numero         int UNIQUE,
  type           type_assemblee NOT NULL,
  date           date NOT NULL,
  heure          text,
  lieu           text,
  ordre_du_jour  text NOT NULL DEFAULT '',
  president      text,
  observations   text,
  statut         statut_assemblee NOT NULL DEFAULT 'brouillon',
  close_le       timestamptz,
  instantane     jsonb,
  pv_signe       text,
  CONSTRAINT assemblee_close CHECK (statut = 'brouillon' OR (numero IS NOT NULL AND instantane IS NOT NULL))
);

CREATE TABLE presence (
  assemblee_id    int NOT NULL REFERENCES assemblee(id) ON DELETE CASCADE,
  associe_id      int NOT NULL REFERENCES associe(id),
  presence        presence_associe NOT NULL DEFAULT 'present',
  represente_par  text,
  PRIMARY KEY (assemblee_id, associe_id)
);

CREATE TABLE resolution (
  id            serial PRIMARY KEY,
  assemblee_id  int NOT NULL REFERENCES assemblee(id) ON DELETE CASCADE,
  ordre         int NOT NULL,
  titre         text NOT NULL,
  texte         text NOT NULL DEFAULT '',
  pour          int  NOT NULL DEFAULT 0 CHECK (pour >= 0),
  contre        int  NOT NULL DEFAULT 0 CHECK (contre >= 0),
  abstention    int  NOT NULL DEFAULT 0 CHECK (abstention >= 0)
);

-- A closed meeting: only its signed minutes may still be attached or replaced
CREATE FUNCTION assemblee_close_figee() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Assemblée close : elle n''est jamais supprimée (registre, ADR 0016)';
  END IF;
  IF (to_jsonb(NEW) - 'pv_signe') <> (to_jsonb(OLD) - 'pv_signe') THEN
    RAISE EXCEPTION 'Assemblée close : elle n''est plus modifiée (registre, ADR 0016)';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER assemblee_close_figee BEFORE UPDATE OR DELETE ON assemblee
  FOR EACH ROW WHEN (OLD.statut = 'close') EXECUTE FUNCTION assemblee_close_figee();

-- Presences and resolutions of a closed meeting are frozen with it
CREATE FUNCTION assemblee_detail_fige() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM assemblee WHERE id = coalesce(NEW.assemblee_id, OLD.assemblee_id) AND statut = 'close') THEN
    RAISE EXCEPTION 'Assemblée close : ses présences et résolutions ne changent plus (registre, ADR 0016)';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;

CREATE TRIGGER presence_figee BEFORE INSERT OR UPDATE OR DELETE ON presence
  FOR EACH ROW EXECUTE FUNCTION assemblee_detail_fige();
CREATE TRIGGER resolution_figee BEFORE INSERT OR UPDATE OR DELETE ON resolution
  FOR EACH ROW EXECUTE FUNCTION assemblee_detail_fige();

COMMIT;
