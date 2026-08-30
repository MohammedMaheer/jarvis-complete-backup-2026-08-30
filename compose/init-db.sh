#!/bin/bash
set -e

# Create additional databases for Jarvis services
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  SELECT 'CREATE DATABASE jarvis_auth' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'jarvis_auth')\gexec
  SELECT 'CREATE DATABASE jarvis_command_center' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'jarvis_command_center')\gexec
  SELECT 'CREATE DATABASE jarvis_whisper' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'jarvis_whisper')\gexec
  SELECT 'CREATE DATABASE jarvis_tts' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'jarvis_tts')\gexec
  SELECT 'CREATE DATABASE jarvis_llm_proxy' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'jarvis_llm_proxy')\gexec
  SELECT 'CREATE DATABASE jarvis_notifications' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'jarvis_notifications')\gexec
EOSQL
