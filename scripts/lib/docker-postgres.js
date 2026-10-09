'use strict';

const net = require('net');
const { execFileSync } = require('child_process');
const { Client } = require('pg');

function getFreePort(startPort = 55432, maxAttempts = 50) {
  return new Promise((resolve, reject) => {
    let port = startPort;
    let attempts = 0;

    function tryPort() {
      attempts += 1;
      if (attempts > maxAttempts) {
        reject(new Error('Could not find a free port for the disposable test database'));
        return;
      }
      const server = net.createServer();
      server.once('error', () => {
        port += 1;
        tryPort();
      });
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(port));
      });
    }
    tryPort();
  });
}

async function waitForPostgres(connectionString, timeoutMs = 30000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    const client = new Client({ connectionString });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (err) {
      lastError = err;
      try { await client.end(); } catch { /* already closed */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Postgres did not become ready within ${timeoutMs}ms: ${lastError && lastError.message}`);
}

// Spins up a throwaway `postgres:16` container for integration tests. Never
// touches any already-running database — this is entirely self-contained
// and torn down unconditionally by the caller.
async function startDisposablePostgres() {
  const port = await getFreePort();
  const containerName = `nika-pilot-test-pg-${Date.now()}`;
  const database = 'nika_pilot_test';

  execFileSync('docker', [
    'run', '-d',
    '--name', containerName,
    '-e', 'POSTGRES_PASSWORD=test',
    '-e', `POSTGRES_DB=${database}`,
    '-p', `127.0.0.1:${port}:5432`,
    'postgres:16',
  ], { stdio: 'inherit' });

  const connectionString = `postgres://postgres:test@127.0.0.1:${port}/${database}`;

  try {
    await waitForPostgres(connectionString);
  } catch (err) {
    stopDisposablePostgres(containerName);
    throw err;
  }

  return { containerName, connectionString, port };
}

function stopDisposablePostgres(containerName) {
  try {
    execFileSync('docker', ['rm', '-f', containerName], { stdio: 'inherit' });
  } catch (err) {
    console.error(`Warning: failed to remove container ${containerName}: ${err.message}`);
  }
}

module.exports = { startDisposablePostgres, stopDisposablePostgres, getFreePort, waitForPostgres };
