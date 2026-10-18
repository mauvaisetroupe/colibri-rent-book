-- ADR 0020: authentication in the application, by passkey (WebAuthn) only: accounts, their passkeys, sessions (cookie),
-- single-use links to register a passkey (first one, another device, recovery), API tokens for scripts. Only digests
-- (SHA-256) of the secrets are stored: a copy of the database gives no access.
BEGIN;

CREATE TABLE utilisateur (
  id       serial PRIMARY KEY,
  email    text NOT NULL UNIQUE,
  nom      text NOT NULL,
  cree_le  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE passkey (
  id              text PRIMARY KEY,                     -- credential id (base64url)
  utilisateur_id  int  NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  cle_publique    bytea NOT NULL,
  compteur        bigint NOT NULL DEFAULT 0,
  transports      text[],
  appareil        text NOT NULL,                        -- name given at registration (« MacBook », « iPhone »)
  cree_le         timestamptz NOT NULL DEFAULT now(),
  utilisee_le     timestamptz
);
CREATE INDEX ON passkey (utilisateur_id);

CREATE TABLE session (
  empreinte       text PRIMARY KEY,                     -- SHA-256 of the cookie
  utilisateur_id  int  NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  cree_le         timestamptz NOT NULL DEFAULT now(),
  expire_le       timestamptz NOT NULL
);
CREATE INDEX ON session (utilisateur_id);

CREATE TABLE lien_enregistrement (
  empreinte       text PRIMARY KEY,                     -- SHA-256 of the link's token
  utilisateur_id  int  NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  expire_le       timestamptz NOT NULL,
  utilise_le      timestamptz
);

CREATE TABLE jeton_api (
  id              serial PRIMARY KEY,
  nom             text NOT NULL,
  empreinte       text NOT NULL UNIQUE,                 -- SHA-256 of the token
  utilisateur_id  int  NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  cree_le         timestamptz NOT NULL DEFAULT now(),
  utilise_le      timestamptz,
  revoque_le      timestamptz
);

COMMIT;
