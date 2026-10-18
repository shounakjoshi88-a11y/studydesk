# Module 1 — Simulated Lab Assessment (10 marks, 45 min)

> Mirror of likely CN-sir pattern. Closed notes first attempt. Answers at bottom — no peeking.

## Section A — Subnetting + Binary (4 marks, 15 min)

**A1 (1m):** Convert to binary: 172.16.45.200. Convert to decimal: 11000000.10101000.00000001.00010100.
**A2 (1m):** 192.168.5.0/27 → block size? List first 2 subnets with usable range + broadcast.
**A3 (1m):** 10.10.10.23/30 → network? usable? broadcast? Can it ping 10.10.10.22?
**A4 (1m):** Supernet 172.16.0.0/24 + 172.16.1.0/24 → ? How many hosts total usable?

## Section B — Topology Domains (3 marks, 10 min)

**B1 (1.5m):** Diagram: 1 router (2 LAN ports), 2x 8-port switches, VLAN 10 + VLAN 20 across both switches. Count collision domains and broadcast domains. Why?
**B2 (1.5m):** Lab: two laptops + switch. `ping 192.168.1.2` works. Run `arp -a` before clearing and after ping. What changes and why? What is the MAC role vs IP role?

## Section C — Longest-match + Concepts Viva (3 marks, 20 min)

**C1 (1m):** Routing table: 0.0.0.0/0 via ISP, 10.0.0.0/8 via R1, 10.1.0.0/16 via R2, 10.1.1.0/24 via R3. Dest 10.1.1.99? Dest 10.2.2.2? Dest 8.8.8.8?
**C2 (1m):** Compress: 2001:0db8:0000:0000:0000:ff00:0042:8329. Identify type of fe80::1 and ::1.
**C3 (1m):** TCP vs UDP: DNS uses? BGP uses? Why? One CoS line: what happens to voice without prioritization during congestion?

---
## Answers (check after timer)

**A1:** 172=10101100, 16=00010000, 45=00101101, 200=11001000 → 10101100.00010000.00101101.11001000. Binary given = 192.168.1.20.
**A2:** /27 mask 255.255.255.224, block 32. Subnet1: 192.168.5.0 usable .1-.30 bcast .31. Subnet2: .32 usable .33-.62 bcast .63.
**A3:** /30 block 4 → net 10.10.10.20, usable .21-.22, bcast .23 (.23 is broadcast, not usable). .23 cannot ping .22 as source (it's bcast). If host were .21, yes.
**A4:** 172.16.0.0/23. 512 total, 510 usable.

**B1:** Collisions = 8+8+2 = 18. Broadcasts = 2 (VLAN10, VLAN20). Switch ports break collisions, VLANs/router break broadcasts.
**B2:** Before: incomplete/empty. After: IP→MAC entry appears. IP = who (L3 end-to-end), MAC = how on LAN (L2 next-hop). ARP broadcast → unicast reply → cache.

**C1:** 10.1.1.99→R3 (/24 longest), 10.2.2.2→R1 (/8), 8.8.8.8→ISP (default).
**C2:** 2001:db8::ff00:42:8329. fe80::1 = link-local, ::1 = loopback.
**C3:** DNS=UDP (fast, small), BGP=TCP 179 (reliable session). Without CoS voice drops/jitters during congestion — CoS prioritizes EF queue.

**Scoring:** 8+/10 = ready. 6-7 = redo cram Sec 5+8. <6 = redo full 90-min plan + re-take.
