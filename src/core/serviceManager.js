import { execSync } from 'node:child_process';
import { createLogger } from './logger.js';

const log = createLogger('services');

/**
 * Service Manager to handle running FlareSolverr and ByParr
 * docker containers concurrently with the application.
 */
export async function startServices(config) {
  if (config.bypass.captcha.startServicesOnStart === false) {
    log.info('Automatic docker services start is disabled.');
    return;
  }

  // Check if docker is available
  try {
    execSync('docker --version', { stdio: 'ignore' });
  } catch (err) {
    log.warn('Docker CLI not found. FlareSolverr and ByParr services will not be auto-started. Make sure Docker is installed and running.', { error: err.message });
    return;
  }

  // Check if docker daemon is running
  try {
    execSync('docker info', { stdio: 'ignore' });
  } catch (err) {
    log.warn('Docker daemon is not running. FlareSolverr and ByParr services will not be auto-started. Please start Docker.', { error: err.message });
    return;
  }

  log.info('Docker found. Ensuring FlareSolverr and ByParr services are running...');

  // Start FlareSolverr on port 8191
  await ensureDockerContainer({
    name: 'pahe-flaresolverr',
    image: 'flaresolverr/flaresolverr:latest',
    ports: '8191:8191',
    envs: []
  });

  // Start ByParr on port 8192
  await ensureDockerContainer({
    name: 'pahe-byparr',
    image: 'ghcr.io/thephaseless/byparr:latest',
    ports: '8192:8191', // Maps host 8192 to container 8191
    envs: []
  });
}

async function ensureDockerContainer({ name, image, ports, envs }) {
  try {
    // Check if container already exists (running or stopped)
    const existing = execSync(`docker ps -a --filter "name=${name}" --format "{{.Names}}"`, { encoding: 'utf8' }).trim();
    
    if (existing === name) {
      log.info(`Container '${name}' already exists. Removing it to ensure fresh startup...`);
      execSync(`docker rm -f ${name}`, { stdio: 'ignore' });
    }

    log.info(`Launching container '${name}' (${image}) on host port ${ports.split(':')[0]}...`);
    const envArgs = envs.flatMap(e => ['-e', e]);
    const runArgs = ['run', '-d', '--name', name, '-p', ports, ...envArgs, '--rm', image];

    execSync(`docker ${runArgs.join(' ')}`, { stdio: 'ignore' });
    log.info(`Container '${name}' started.`);
  } catch (err) {
    log.error(`Failed to start Docker container '${name}'`, { error: err.message });
  }
}

export async function stopServices() {
  try {
    execSync('docker --version', { stdio: 'ignore' });
  } catch {
    return; // Docker not available, nothing to stop
  }

  const containers = ['pahe-flaresolverr', 'pahe-byparr'];
  for (const name of containers) {
    try {
      const running = execSync(`docker ps --filter "name=${name}" --format "{{.Names}}"`, { encoding: 'utf8' }).trim();
      if (running === name) {
        log.info(`Stopping Docker container '${name}'...`);
        execSync(`docker stop ${name}`, { stdio: 'ignore' });
        log.info(`Container '${name}' stopped.`);
      }
    } catch (err) {
      // Suppress errors during shutdown
    }
  }
}
