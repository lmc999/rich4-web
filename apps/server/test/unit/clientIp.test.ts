import { describe, expect, it, vi } from 'vitest';
import { clientIp, isTrustedProxy, privateClientIpWarner } from '../../src/net/io';

function sock(address: string, xff?: string | string[]) {
  return {
    handshake: { address, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } },
  } as unknown as Parameters<typeof clientIp>[0];
}

describe('clientIp（design/net.md §10.3）', () => {
  it('可信代理网段：本机、私有网段、IPv4-mapped', () => {
    for (const a of ['127.0.0.1', '::1', '10.1.2.3', '172.18.0.5', '192.168.1.1', '::ffff:127.0.0.1', 'fd00::1']) {
      expect(isTrustedProxy(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '172.32.0.1', '2001:db8::1', 'not-an-ip', '']) expect(isTrustedProxy(a), a).toBe(false);
  });

  it('TRUST_PROXY 关闭：一律用直连地址', () => {
    expect(clientIp(sock('127.0.0.1', '9.9.9.9'), false)).toBe('127.0.0.1');
  });

  it('直连对端不是可信代理：忽略客户端自带的 X-Forwarded-For', () => {
    expect(clientIp(sock('203.0.113.7', '1.2.3.4'), true)).toBe('203.0.113.7');
    expect(clientIp(sock('::ffff:203.0.113.7', '1.2.3.4'), true)).toBe('203.0.113.7');
  });

  it('经本机反代：取最右边的不可信地址（最左段可被伪造）', () => {
    // nginx $proxy_add_x_forwarded_for：客户端伪造 1.2.3.4，真实对端 203.0.113.7 被追加在最右
    expect(clientIp(sock('127.0.0.1', '1.2.3.4, 203.0.113.7'), true)).toBe('203.0.113.7');
    // 多级可信代理
    expect(clientIp(sock('172.18.0.2', '203.0.113.7, 10.0.0.5'), true)).toBe('203.0.113.7');
    expect(clientIp(sock('::ffff:172.18.0.2', ['203.0.113.9']), true)).toBe('203.0.113.9');
    // 全是内网地址（局域网部署）：取最左
    expect(clientIp(sock('127.0.0.1', '192.168.1.20'), true)).toBe('192.168.1.20');
    // 没有或无效的 XFF：用直连地址
    expect(clientIp(sock('127.0.0.1'), true)).toBe('127.0.0.1');
    expect(clientIp(sock('127.0.0.1', 'garbage'), true)).toBe('127.0.0.1');
  });

  it('客户端 IP 塌缩告警：第一次解析成本机或私有地址时 warn 一次，公网地址不告警', () => {
    const warn = vi.fn();
    const note = privateClientIpWarner({ warn });
    note('203.0.113.7', '172.21.0.3');
    note('2001:db8::1', '172.21.0.3');
    expect(warn).not.toHaveBeenCalled();
    // docker-proxy 转发的 IPv6 访客、未被 Caddy 信任的前置代理：都显示成 compose 网络的网关
    note('172.21.0.1', '172.21.0.3');
    note('10.0.0.8', '172.21.0.3');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toEqual({ ip: '172.21.0.1', peer: '172.21.0.3' });
  });
});
