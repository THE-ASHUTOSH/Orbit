/**
 * Real measurements, not vibes.
 *
 * In a container the number that matters is the whole cgroup - Chromium spawns a
 * renderer per tab plus GPU/zygote helpers, so `process.cpuUsage()` of the Node
 * process alone would understate reality by an order of magnitude. cgroup v2
 * exposes both numbers as two file reads; outside Linux we fall back to this
 * process, which is honest but only useful for development.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import type { ServerMetrics } from '@orbit/protocol';
import type { InputManager } from './browser/InputManager.js';
import type { StreamManager } from './browser/StreamManager.js';
import type { TabManager } from './browser/TabManager.js';

const CGROUP_CPU = '/sys/fs/cgroup/cpu.stat';
const CGROUP_MEM = '/sys/fs/cgroup/memory.current';
const CGROUP_QUOTA = '/sys/fs/cgroup/cpu.max';

/**
 * How many CPUs this process may actually use.
 *
 * os.cpus() reports the HOST's cores even inside a container, so a container
 * limited to 4 CPUs on a 15-core machine would report its CPU usage as a
 * quarter of the truth. cpu.max holds "<quota> <period>" in microseconds, or
 * "max <period>" when uncapped.
 */
function effectiveCpuCount(): number {
  try {
    const [quota, period] = readFileSync(CGROUP_QUOTA, 'utf8').trim().split(/\s+/);
    if (quota && quota !== 'max' && period) {
      const cpus = Number(quota) / Number(period);
      if (Number.isFinite(cpus) && cpus > 0) return cpus;
    }
  } catch {
    /* not cgroup v2, or no limit set */
  }
  return Math.max(1, os.cpus().length);
}

function readCgroupCpuUsec(): number | null {
  try {
    const m = /usage_usec\s+(\d+)/.exec(readFileSync(CGROUP_CPU, 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function readCgroupMemory(): number | null {
  try {
    return Number(readFileSync(CGROUP_MEM, 'utf8').trim());
  } catch {
    return null;
  }
}

export class Metrics {
  private readonly startedAt = Date.now();
  private lastSample = { at: Date.now(), cpuUsec: readCgroupCpuUsec(), procCpu: process.cpuUsage() };
  /** Denominator for cpuPercent: the container's allowance, not the host's. */
  private readonly cores = effectiveCpuCount();

  constructor(
    private readonly tabs: TabManager,
    private readonly streams: StreamManager,
    private readonly input: InputManager,
  ) {}

  /** Percentage of all available CPU, container-wide when cgroup v2 is present. */
  private cpuPercent(): number {
    const now = Date.now();
    const elapsedUs = (now - this.lastSample.at) * 1000;
    if (elapsedUs <= 0) return 0;
    const cgroupNow = readCgroupCpuUsec();
    let percent: number;
    if (cgroupNow !== null && this.lastSample.cpuUsec !== null) {
      percent = ((cgroupNow - this.lastSample.cpuUsec) / (elapsedUs * this.cores)) * 100;
    } else {
      const cpu = process.cpuUsage();
      const usedUs = cpu.user - this.lastSample.procCpu.user + (cpu.system - this.lastSample.procCpu.system);
      percent = (usedUs / (elapsedUs * this.cores)) * 100;
    }
    this.lastSample = { at: now, cpuUsec: cgroupNow, procCpu: process.cpuUsage() };
    return Math.max(0, Math.min(100, Number(percent.toFixed(1))));
  }

  snapshot(connections: number): ServerMetrics {
    const rates = this.streams.rates();
    const pct = this.input.percentiles();
    return {
      cpuPercent: this.cpuPercent(),
      rssBytes: readCgroupMemory() ?? process.memoryUsage.rss(),
      tabs: this.tabs.count,
      users: connections,
      framesPerSecond: Number(rates.fps.toFixed(1)),
      bytesPerSecond: Math.round(rates.bps),
      inputQueueDepth: this.input.totalQueueDepth,
      p50InputDispatchMs: pct.p50,
      p95InputDispatchMs: pct.p95,
      droppedFrames: rates.dropped,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }
}
