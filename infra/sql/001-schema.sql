-- Execute com o papel de servidor. Dados não são acessíveis pelo cliente anon/authenticated.
CREATE TABLE IF NOT EXISTS email_provider_slots (provider TEXT PRIMARY KEY, next_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS auth_attempt_limits (scope_hash TEXT PRIMARY KEY, window_at BIGINT NOT NULL, total INTEGER NOT NULL);
ALTER TABLE email_provider_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_attempt_limits ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS core_simulado (
  id SERIAL PRIMARY KEY,
  titulo TEXT NOT NULL,
  data_criacao TEXT NOT NULL,
  gabarito_oficial TEXT NOT NULL CHECK (gabarito_oficial::jsonb IS NOT NULL),
  total_questoes INTEGER NOT NULL DEFAULT 50,
  temas TEXT NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(temas::jsonb) = 'array')
);
CREATE TABLE IF NOT EXISTS core_lotecorrecao (
  id SERIAL PRIMARY KEY,
  criado_em TEXT NOT NULL,
  simulado_id INTEGER NOT NULL REFERENCES core_simulado(id),
  gabarito_snapshot TEXT NOT NULL DEFAULT '{}' CHECK (gabarito_snapshot::jsonb IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS core_resultadoaluno (
  id SERIAL PRIMARY KEY,
  matricula TEXT NOT NULL,
  respostas_detectadas TEXT NOT NULL CHECK (respostas_detectadas::jsonb IS NOT NULL),
  total_acertos INTEGER NOT NULL,
  total_erros INTEGER NOT NULL,
  total_rasuras INTEGER NOT NULL,
  total_brancos INTEGER NOT NULL,
  nota_percentual DOUBLE PRECISION NOT NULL,
  imagem_debug TEXT,
  status TEXT NOT NULL,
  lote_id INTEGER NOT NULL REFERENCES core_lotecorrecao(id),
  mensagem_leitura TEXT NOT NULL DEFAULT '',
  total_incertas INTEGER NOT NULL DEFAULT 0
);
-- Adições seguras para bancos de versões anteriores.
ALTER TABLE core_simulado ADD COLUMN IF NOT EXISTS total_questoes INTEGER NOT NULL DEFAULT 50;
ALTER TABLE core_simulado ADD COLUMN IF NOT EXISTS temas TEXT NOT NULL DEFAULT '[]';
ALTER TABLE core_lotecorrecao ADD COLUMN IF NOT EXISTS gabarito_snapshot TEXT NOT NULL DEFAULT '{}';
ALTER TABLE core_resultadoaluno ADD COLUMN IF NOT EXISTS mensagem_leitura TEXT NOT NULL DEFAULT '';
ALTER TABLE core_resultadoaluno ADD COLUMN IF NOT EXISTS total_incertas INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core_resultadoaluno ADD COLUMN IF NOT EXISTS arquivo_origem TEXT NOT NULL DEFAULT '';
ALTER TABLE core_resultadoaluno ADD COLUMN IF NOT EXISTS pagina_origem INTEGER;
ALTER TABLE core_resultadoaluno ADD COLUMN IF NOT EXISTS matricula_fonte TEXT NOT NULL DEFAULT 'manual';
UPDATE core_lotecorrecao l SET gabarito_snapshot = s.gabarito_oficial
  FROM core_simulado s WHERE l.simulado_id=s.id AND l.gabarito_snapshot='{}';
CREATE INDEX IF NOT EXISTS omr_envios_simulado ON core_lotecorrecao(simulado_id);
CREATE INDEX IF NOT EXISTS omr_resultados_envio ON core_resultadoaluno(lote_id);
CREATE TABLE IF NOT EXISTS student_contacts (
  matricula TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  nome TEXT NOT NULL DEFAULT '',
  curso TEXT NOT NULL DEFAULT '',
  atualizado_em TEXT NOT NULL
);
ALTER TABLE student_contacts ADD COLUMN IF NOT EXISTS curso TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS report_feedback (
  resultado_id INTEGER PRIMARY KEY REFERENCES core_resultadoaluno(id) ON DELETE CASCADE,
  nota_redacao DOUBLE PRECISION CHECK (nota_redacao IS NULL OR nota_redacao BETWEEN 0 AND 1000),
  feedback_redacao TEXT NOT NULL DEFAULT '',
  atualizado_em TEXT NOT NULL
);
ALTER TABLE report_feedback ADD COLUMN IF NOT EXISTS competencias_redacao TEXT NOT NULL DEFAULT '[]';
ALTER TABLE report_feedback ADD COLUMN IF NOT EXISTS avaliador_redacao TEXT NOT NULL DEFAULT '';
ALTER TABLE report_feedback ADD COLUMN IF NOT EXISTS situacao_redacao TEXT NOT NULL DEFAULT '';
ALTER TABLE report_feedback ADD COLUMN IF NOT EXISTS origem_redacao TEXT NOT NULL DEFAULT 'manual';
CREATE TABLE IF NOT EXISTS report_deliveries (
  id SERIAL PRIMARY KEY,
  resultado_id INTEGER NOT NULL REFERENCES core_resultadoaluno(id) ON DELETE CASCADE,
  destinatario TEXT NOT NULL,
  status TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  message_id TEXT,
  erro TEXT NOT NULL DEFAULT '',
  criado_em TEXT NOT NULL,
  UNIQUE(resultado_id, destinatario, content_hash)
);
CREATE TABLE IF NOT EXISTS report_delivery_plans (
  token_hash TEXT PRIMARY KEY,
  simulado_id INTEGER NOT NULL REFERENCES core_simulado(id) ON DELETE CASCADE,
  payload TEXT NOT NULL CHECK (payload::jsonb IS NOT NULL),
  expira_em TEXT NOT NULL,
  criado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts_import_plans (
  token_hash TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK (payload::jsonb IS NOT NULL),
  expira_em TEXT NOT NULL, criado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS uploaded_files (
  id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, size INTEGER NOT NULL CHECK (size>0 AND size<=20971520),
  purpose TEXT NOT NULL CHECK (purpose IN ('gabarito','prova')), created_at TEXT NOT NULL, consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS essay_import_plans (
  token_hash TEXT PRIMARY KEY, simulado_id INTEGER NOT NULL REFERENCES core_simulado(id) ON DELETE CASCADE,
  payload TEXT NOT NULL CHECK (payload::jsonb IS NOT NULL), expira_em TEXT NOT NULL, criado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS report_access_links (
  token_hash TEXT PRIMARY KEY, delivery_id INTEGER NOT NULL REFERENCES report_deliveries(id) ON DELETE CASCADE,
  operation_hash TEXT NOT NULL UNIQUE, criado_em TEXT NOT NULL, expira_em TEXT NOT NULL,
  ativado_em TEXT, revogado_em TEXT
);
CREATE INDEX IF NOT EXISTS report_access_delivery ON report_access_links(delivery_id);
CREATE INDEX IF NOT EXISTS report_access_expiry ON report_access_links(expira_em);
CREATE TABLE IF NOT EXISTS proof_import_plans (
  id TEXT PRIMARY KEY, simulado_id INTEGER NOT NULL REFERENCES core_simulado(id) ON DELETE CASCADE,
  payload TEXT NOT NULL CHECK (payload::jsonb IS NOT NULL), estado TEXT NOT NULL,
  criado_em TEXT NOT NULL, expira_em TEXT NOT NULL,
  envio_id INTEGER REFERENCES core_lotecorrecao(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS proof_import_pages (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES proof_import_plans(id) ON DELETE CASCADE,
  file_index INTEGER NOT NULL, page_number INTEGER NOT NULL, identity TEXT,
  matricula TEXT NOT NULL DEFAULT '', estado TEXT NOT NULL DEFAULT 'PENDENTE', claim_id TEXT, claim_at TEXT,
  resultado_id INTEGER REFERENCES core_resultadoaluno(id) ON DELETE SET NULL,
  UNIQUE(plan_id, file_index, page_number)
);
CREATE INDEX IF NOT EXISTS proof_pages_plan ON proof_import_pages(plan_id);
-- Registros legados ficam sem proprietário até a migração explícita, sem acesso por professores.
ALTER TABLE report_deliveries ADD COLUMN IF NOT EXISTS tentativa_em TEXT;
ALTER TABLE core_simulado ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT '';
ALTER TABLE core_simulado ADD COLUMN IF NOT EXISTS expira_em TEXT;
ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT '';
ALTER TABLE contacts_import_plans ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT '';
ALTER TABLE student_contacts ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT '';
ALTER TABLE student_contacts ADD COLUMN IF NOT EXISTS expira_em TEXT;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='student_contacts'::regclass AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (matricula)') THEN
    ALTER TABLE student_contacts DROP CONSTRAINT student_contacts_pkey;
    ALTER TABLE student_contacts ADD PRIMARY KEY(owner_id,matricula);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS omr_simulado_owner ON core_simulado(owner_id,expira_em);
CREATE INDEX IF NOT EXISTS omr_upload_owner ON uploaded_files(owner_id);
CREATE TABLE IF NOT EXISTS storage_deletions (path TEXT PRIMARY KEY, criado_em TEXT NOT NULL);
ALTER TABLE storage_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE essay_import_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_access_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE proof_import_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE proof_import_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploaded_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts_import_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE core_simulado ENABLE ROW LEVEL SECURITY;
ALTER TABLE core_lotecorrecao ENABLE ROW LEVEL SECURITY;
ALTER TABLE core_resultadoaluno ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_delivery_plans ENABLE ROW LEVEL SECURITY;
-- Nenhuma policy pública: NestJS usa conexão de servidor (postgres/service role).
-- REVOKE condicionado permite executar este SQL também em PostgreSQL sem Supabase.
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE core_simulado, core_lotecorrecao, core_resultadoaluno, student_contacts, report_feedback, report_deliveries, report_delivery_plans, contacts_import_plans, uploaded_files, email_provider_slots, auth_attempt_limits, essay_import_plans, report_access_links, proof_import_plans, proof_import_pages, storage_deletions FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
