#!/usr/bin/env python3
"""Fixed-target ICMP sampler. No remote commands, SSH access or download queue."""
import concurrent.futures
import datetime
import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
import urllib.error
import urllib.request

TARGETS = {'cu': 'cu.skrskr.net', 'cm': 'cm.skrskr.net', 'ct': 'ct.skrskr.net'}

def failed(carrier, error, address=None):
    return dict(carrier=carrier, address=address, sent=0, received=0,
                minMs=None, avgMs=None, maxMs=None, error=error)

def parse_ping(carrier, address, output, code):
    if 'Operation not permitted' in output or 'Permission denied' in output:
        return failed(carrier, 'permission', address)
    counts = re.search(r'(\d+) packets transmitted,\s*(\d+) (?:packets )?received', output)
    if not counts or int(counts[1]) != 5 or code not in (0, 1):
        return failed(carrier, 'parse', address)
    sent, received = map(int, counts.groups())
    if received > sent:
        return failed(carrier, 'parse', address)
    result = dict(carrier=carrier, address=address, sent=sent, received=received,
                  minMs=None, avgMs=None, maxMs=None, error=None)
    if received:
        times = re.search(r'(?:rtt|round-trip) [^=]+ = ([\d.]+)/([\d.]+)/([\d.]+)/', output)
        if not times:
            return failed(carrier, 'parse', address)
        result.update(zip(('minMs', 'avgMs', 'maxMs'), map(float, times.groups())))
    return result

def sample(carrier, hostname):
    try:
        addresses = socket.getaddrinfo(hostname, None, socket.AF_INET, socket.SOCK_DGRAM)
        address = sorted({a[4][0] for a in addresses})[0]
        if not ipaddress.ip_address(address).is_global:
            return failed(carrier, 'target')
    except (socket.gaierror, IndexError, ValueError):
        return failed(carrier, 'dns')
    try:
        result = subprocess.run(['ping', '-4', '-n', '-c', '5', '-i', '1', '-W', '2', '-w', '12', address],
                                capture_output=True, text=True, timeout=15,
                                env={**os.environ, 'LC_ALL': 'C'})
        return parse_ping(carrier, address, result.stdout + result.stderr, result.returncode)
    except subprocess.TimeoutExpired:
        return failed(carrier, 'timeout', address)
    except OSError:
        return failed(carrier, 'tool', address)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def main():
    endpoint = os.environ.get('NAV_PROBE_ENDPOINT', '')
    if endpoint not in ('https://nav.skrskr.net/api/monitor/probes/report', 'https://nav.cristsau.cn/api/monitor/probes/report'):
        raise ValueError('endpoint')
    token = os.environ.get('NAV_PROBE_TOKEN', '')
    if not re.fullmatch(r'[a-f0-9]{64}', token):
        raise ValueError('credential')
    node = int(os.environ['NAV_PROBE_NODE_ID'])
    if node < 1:
        raise ValueError('node')
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        samples = list(executor.map(lambda pair: sample(*pair), TARGETS.items()))
    services = []
    for unit in os.environ.get('NAV_PROBE_SERVICES', 'nav-monitor-agent.service').split(',')[:8]:
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9@_.-]{0,79}\.service', unit):
            continue
        try:
            output = subprocess.run(['systemctl', 'is-active', unit], capture_output=True, text=True, timeout=2).stdout.strip()
            state = output if output in ('active', 'inactive', 'failed', 'activating') else 'unknown'
        except (OSError, subprocess.TimeoutExpired):
            state = 'unknown'
        services.append(dict(unit=unit, status=state))
    payload = dict(nodeId=node, observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), samples=samples, services=services)
    request = urllib.request.Request(endpoint, json.dumps(payload).encode(),
                                     headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Origin': endpoint.split('/api/')[0]}, method='POST')
    # Ignore ambient HTTP proxy settings; never follow a redirect with the bearer token.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=15) as response:
        if response.status != 200 or not json.loads(response.read(1024)).get('ok'):
            raise ValueError('report')
    print('probe report accepted')

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('probe report failed; check service access, clock and connectivity', file=sys.stderr)
        sys.exit(1)
