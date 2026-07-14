#!/usr/bin/env python3
"""Minimal WebSocket echo server using only stdlib."""
import base64
import hashlib
import os
import socket
import struct
import threading

def handle_client(conn, addr):
    try:
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = conn.recv(4096)
            if not chunk:
                return
            data += chunk

        lines = data.decode("utf-8", errors="replace").split("\r\n")
        key = None
        protocols = []
        for line in lines:
            if line.lower().startswith("sec-websocket-key:"):
                key = line.split(":", 1)[1].strip()
            elif line.lower().startswith("sec-websocket-protocol:"):
                protocols = line.split(":", 1)[1].strip().split(",")

        if not key:
            return

        accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
        ).decode()

        response = (
            f"HTTP/1.1 101 Switching Protocols\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n"
        )

        chosen = None
        for p in protocols:
            p = p.strip()
            if p:
                chosen = p
                break
        if chosen:
            response += f"Sec-WebSocket-Protocol: {chosen}\r\n"

        response += "\r\n"
        conn.sendall(response.encode())

        while True:
            header = recv_exact(conn, 2)
            if not header or len(header) < 2:
                break

            b1, b2 = header[0], header[1]
            fin = b1 & 0x80
            opcode = b1 & 0x0F
            masked = b2 & 0x80
            length = b2 & 0x7F

            if length == 126:
                ext = recv_exact(conn, 2)
                length = struct.unpack("!H", ext)[0]
            elif length == 127:
                ext = recv_exact(conn, 8)
                length = struct.unpack("!Q", ext)[0]

            mask = b""
            if masked:
                mask = recv_exact(conn, 4)

            payload = recv_exact(conn, length) if length > 0 else b""
            if masked and payload:
                payload = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))

            if opcode == 0x8:
                code = 1005
                if len(payload) >= 2:
                    code = struct.unpack("!H", payload[:2])[0]
                    close_payload = payload[2:]
                else:
                    close_payload = b""
                close_frame = bytes([0x88, 2 + len(close_payload)]) + struct.pack("!H", code) + close_payload
                try:
                    conn.sendall(close_frame)
                except:
                    pass
                conn.close()
                break
            elif opcode == 0x9:
                response = bytes([0x8A, len(payload)]) + payload
                conn.sendall(response)
            elif opcode in (0x1, 0x2, 0x0):
                if len(payload) > 65535:
                    resp = bytes([fin | opcode, 127]) + struct.pack("!Q", len(payload))
                elif len(payload) > 125:
                    resp = bytes([fin | opcode, 126]) + struct.pack("!H", len(payload))
                else:
                    resp = bytes([fin | opcode, len(payload)])
                conn.sendall(resp + payload)
    except Exception as e:
        pass
    finally:
        try:
            conn.close()
        except:
            pass

def recv_exact(conn, n):
    data = b""
    while len(data) < n:
        chunk = conn.recv(n - len(data))
        if not chunk:
            return None
        data += chunk
    return data

def main():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 8787))
    server.listen(128)
    print("WS echo server listening on ws://127.0.0.1:8787", flush=True)
    while True:
        conn, addr = server.accept()
        threading.Thread(target=handle_client, args=(conn, addr), daemon=True).start()

if __name__ == "__main__":
    main()