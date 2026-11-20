const { execSync } = require('child_process');
const fs = require('fs');

let _cached = null;

function detect() {
  if (_cached) return _cached;

  const info = {
    os: process.platform,
    arch: process.arch,
    distro: 'unknown',
    hasDisplay: false,
    displayServer: null,
    tools: [],
    shell: process.env.SHELL || '/bin/bash',
    homeDir: process.env.HOME || '/root',
    isWSL: false,
  };

  // Detect distro
  try {
    if (fs.existsSync('/etc/os-release')) {
      const rel = fs.readFileSync('/etc/os-release', 'utf-8');
      const idMatch = rel.match(/^ID=(.+)$/m);
      if (idMatch) info.distro = idMatch[1].replace(/"/g, '');
    }
  } catch {}

  // Detect WSL
  try {
    const uname = execSync('uname -r 2>/dev/null', { encoding: 'utf-8' }).toLowerCase();
    info.isWSL = uname.includes('microsoft') || uname.includes('wsl');
  } catch {}

  // Detect display
  if (process.env.DISPLAY) {
    info.hasDisplay = true;
    info.displayServer = 'x11';
  } else if (process.env.WAYLAND_DISPLAY) {
    info.hasDisplay = true;
    info.displayServer = 'wayland';
  }

  // Check for virtual display support
  const toolChecks = [
    'nmap', 'nikto', 'gobuster', 'dirb', 'sqlmap', 'hydra', 'john',
    'metasploit-framework', 'burpsuite', 'wireshark', 'zaproxy',
    'ffuf', 'wfuzz', 'enum4linux', 'smbclient', 'crackmapexec',
    'chromium', 'firefox', 'libreoffice',
    'ffmpeg', 'ffprobe',
    'Xvfb', 'x11vnc', 'websockify', 'xdotool', 'scrot', 'import',
    'python3', 'ruby', 'go', 'rustc', 'gcc',
    'docker', 'podman',
    'curl', 'wget', 'git', 'jq', 'tmux',
  ];

  for (const tool of toolChecks) {
    try {
      execSync(`which ${tool} 2>/dev/null`, { encoding: 'utf-8' });
      info.tools.push(tool);
    } catch {}
  }

  // Check for GUI display deps specifically
  info.hasVirtualDisplay = info.tools.includes('Xvfb') && info.tools.includes('x11vnc') && info.tools.includes('websockify');

  // Check for passwordless sudo
  try {
    execSync('sudo -n true 2>/dev/null', { timeout: 3000 });
    info.hasSudo = true;
  } catch {
    info.hasSudo = false;
  }

  _cached = info;
  return info;
}

function invalidate() {
  _cached = null;
}

function summary() {
  const info = detect();
  const lines = [
    `OS: ${info.os} (${info.arch})`,
    `Distro: ${info.distro}${info.isWSL ? ' (WSL)' : ''}`,
    `Sudo: ${info.hasSudo ? 'yes (passwordless)' : 'no'}`,
    `Display: ${info.hasDisplay ? info.displayServer : 'none'}`,
    `Virtual display support: ${info.hasVirtualDisplay ? 'yes' : 'no (install xvfb x11vnc novnc)'}`,
    `Shell: ${info.shell}`,
    `Available tools: ${info.tools.join(', ') || 'none detected'}`,
  ];
  return lines.join('\n');
}

module.exports = { detect, invalidate, summary };
