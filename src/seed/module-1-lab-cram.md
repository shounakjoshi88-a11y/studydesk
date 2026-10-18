# Module 1: Networking Fundamentals — Lab Cram (for tomorrow, 10 marks)

> Official Module 1 = Identify concepts/functionality of fundamental elements of networking.
> Source: Juniper JNCIA-Junos objectives + IJOS + NWTraining curriculum. This is the exact checklist your CN sir will test.

## 0. What sir can ask in LAB (not just theory)

Since it's a **lab assessment, no absentee re-test**, expect 10 marks split like:
- **4 marks:** subnetting + binary-decimal + supernetting (pen/paper or `python3` / calculator-off)
- **3 marks:** topology diagram → count collision domains / broadcast domains, router vs switch vs hub role
- **3 marks:** longest-match routing table lookup + ARP/MAC + TCP vs UDP viva + IPv6 compression

You must be able to **do, not just define**. Drills below.

---

## 1. Collision vs Broadcast domains (guaranteed 2 marks)

| Device | Collision domains | Broadcast domains | Why |
|--------|------------------|-------------------|-----|
| Hub (1x 8-port) | 1 | 1 | Repeats everything, half-duplex, CSMA/CD |
| Bridge 2-port | 2 | 1 | Breaks collisions only |
| Switch 8-port (no VLAN) | 8 (per port) | 1 | Each port = own collision domain |
| Switch 8-port + 2 VLANs | 8 | 2 (per VLAN/subnet) | VLAN = broadcast boundary |
| Router 3-port | 3 | 3 (per interface) | Breaks both |

**Trick:** `collision domains = switch ports + router ports`. `broadcast domains = VLANs/subnets = router interfaces`.
**Example lab Q:** "2 switches (12-port each), 1 router (2-port), 3 VLANs" → Collisions = 12+12+2 = 26. Broadcasts = 3.
**CSMA/CD:** legacy half-duplex contention. Full-duplex switches = no collisions needed.

---

## 2. Router vs Switch vs Hub (viva line)

- **Hub L1:** repeats bits, no MAC table, one collision domain. Dead tech, exam trap only.
- **Switch L2:** learns MAC per port (`show ethernet-switching table`), forwards by MAC, breaks collisions. VLANs break broadcasts.
- **Router L3:** looks up IP in routing table, longest-match, breaks broadcasts, connects different subnets.
- One-liner for viva: *"Switch forwards by MAC within a subnet, router forwards by IP between subnets."*

---

## 3. Ethernet networks (1 mark)

- Frame: Preamble + Dest MAC (6B) + Src MAC (6B) + EtherType + Payload + FCS.
- MAC 48-bit hex, e.g. `3c:61:04:5a:2b:11`, OUI first 24 bits = vendor.
- Duplex: full (both ways, switched) vs half (hub, CSMA/CD).
- MTU 1500 default, jumbo 9000 for DC.
- Lab: `show interfaces extensive | match "MAC|errors"` → CRC/framing errors = L1/L2 fault. `show arp` / `show ethernet-switching table`.

---

## 4. L2 addressing + ARP (lab demo-able)

- ARP resolves **IP → MAC in same subnet**. `arp -a` (Windows/Linux) or Junos `show arp`.
- Flow: A (10.1.1.1) wants B (10.1.1.2) → ARP broadcast "who has 10.1.1.2?" → B replies unicast with MAC → cached ~20 min.
- Proxy ARP: router answers for another host (avoid in modern nets).
- **Lab task sir may give:** ping two PCs, show `arp -a` before/after, explain MAC learned. Practice this tonight.

---

## 5. IPv4 / masks / subnetting (4 marks — MOST IMPORTANT)

### Binary table (memorize)
```
128 64 32 16 8 4 2 1
/24 = 255.255.255.0, /16 = 255.255.0.0, /30 = 255.255.255.252
```

### Formulas
- Hosts = 2^(32-prefix) - 2 (except /31 = 2 usable RFC3021, /32 = 1 host route)
- Networks from /n borrowing b bits = 2^b
- Common: /24=256 (254 usable), /25=128, /26=64, /27=32, /28=16, /29=8, /30=4 (2 usable P2P), /31=2, /32=1

### 60-second subnet trick (practice 10x tonight)
Given 192.168.10.0/26 → block size = 256-192 = 64 → subnets: .0, .64, .128, .192. Each: network, 62 usable, broadcast (.63, .127...).
Given 10.0.0.13/29 → block 8 → subnet 10.0.0.8, usable .9-.14, broadcast .15.

### Private ranges (viva)
- 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16. Loopback 127.0.0.1, link-local 169.254.x.x, multicast 224.0.0.0/4.

### Supernetting (route summarization)
- 192.168.0.0/24 + 192.168.1.0/24 → 192.168.0.0/23. Rule: same bits, prefix-1. Saves routing table.

---

## 6. IPv6 (1-2 marks)

- 128-bit hex, 8 groups: `2001:db8:0:0:0:0:2:1` → compress `2001:db8::2:1` (only one `::` allowed, drop leading zeros).
- Types: Global Unicast (2000::/3), Unique Local (fc00::/7 private), Link-Local (fe80::/10, auto), Multicast (ff00::/8), Loopback ::1.
- Default LAN prefix /64. No ARP — uses NDP (Neighbor Discovery).
- Practice: expand/compress 5 addresses. Sir loves asking "compress this".

---

## 7. Decimal ↔ Binary (lab will ask to convert)

- 192 = 11000000, 168 = 10101000, 10 = 00001010, 255 = 11111111, 0 = 00000000.
- Drill: 173 → 10101101 (128+32+8+4+1). 240 mask = 11110000 = /28.
- Speed trick: write 128-64-32-16-8-4-2-1 row, subtract left to right.

---

## 8. Longest-match routing (guaranteed 1-2 marks)

Most specific prefix wins, regardless of protocol.
```
10.0.0.0/8 via R1
10.1.0.0/16 via R2
10.1.1.0/24 via R3
dest 10.1.1.50 → via R3 (/24)
dest 10.1.5.5 → via R2 (/16)
```
Lab on Junos: `show route 10.1.1.50` or `show route forwarding-table destination 10.1.1.50`.

---

## 9. TCP vs UDP (viva 1 mark)

| | TCP | UDP |
|---|---|---|
| Type | Connection-oriented, 3-way handshake SYN/SYN-ACK/ACK | Connectionless, no handshake |
| Reliable? | Yes (seq/ack, retransmit) | No (best-effort) |
| Header | 20B+ | 8B |
| Use | HTTP, SSH, BGP, FTP | DNS, DHCP, voice/video, SNMP, RIP |
| Ports | src+dst 16-bit each | same |

One-liner: *"TCP calls before speaking, UDP shouts."*

---

## 10. CoS basics (1 mark, often skipped — don't skip)

- Classification (DSCP/IP-prec) → queueing → scheduling (strict-priority vs weighted) → drop (RED/tail).
- Junos: forwarding-classes (best-effort, assured, expedited). Voice = expedited-forwarding.
- Viva line: *"CoS doesn't add bandwidth, it decides who suffers during congestion."*

---

## 11. Tonight's 90-min plan

1. **0-25 min:** subnet 10 addresses by hand + 10 binary conversions (no calculator).
2. **25-45 min:** draw 3 topologies, count domains. Do ARP lab: `ping` + `arp -a`.
3. **45-65 min:** longest-match 15 lookups + IPv6 compress 10.
4. **65-90 min:** do `module-1-test-10marks.md` timed, then re-read misses.

## 12. Files in this folder for tomorrow
- `understanding.md` — full Junos context
- `module-1-lab-cram.md` — this file (memorize)
- `module-1-test-10marks.md` — timed mock, do twice
- `module-1-youtube-vscode.md` — videos + in-editor watching
- `../study material/` — your class PDFs/DOCXs (IP/TCP headers, OSPF)
