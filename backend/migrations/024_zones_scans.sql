-- ADR 0025: on a scanned page, the text read by the scanner is not trusted; what is masked there are zones drawn by
-- hand: a model per supplier, adjusted invoice by invoice. A version in images says which of its pages were scans.
BEGIN;

-- Zones of the scans of this supplier: [{ "page": 1, "x0": …, "y0": …, "x1": …, "y1": … }] (fractions of the page)
ALTER TABLE fournisseur ADD COLUMN zones_masquees jsonb NOT NULL DEFAULT '[]';

-- Zones of this invoice, adjusted by hand; NULL: those of its supplier
ALTER TABLE facture ADD COLUMN zones_masquees jsonb;

-- Pages of the PDF that were scans when the version was made (masked by zones only)
ALTER TABLE facture_annexe ADD COLUMN pages_scannees int[] NOT NULL DEFAULT '{}';

COMMIT;
