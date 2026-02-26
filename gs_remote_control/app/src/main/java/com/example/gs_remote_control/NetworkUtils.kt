package com.example.gs_remote_control

import android.content.Context
import android.net.wifi.WifiManager
import java.net.Inet4Address
import java.net.NetworkInterface

object NetworkUtils {
    fun getLocalIpAddress(context: Context): String? {
        // 1) 优先尝试 Wi‑Fi IP
        try {
            val wm = context.applicationContext
                .getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val ipInt = wm?.connectionInfo?.ipAddress ?: 0
            if (ipInt != 0) {
                return formatIpv4(ipInt)
            }
        } catch (_: Exception) {
            // ignore and fallback
        }

        // 2) 回退：遍历网络接口，取第一个非回环的 IPv4
        return try {
            val interfaces = NetworkInterface.getNetworkInterfaces()
            while (interfaces.hasMoreElements()) {
                val intf = interfaces.nextElement()
                if (!intf.isUp || intf.isLoopback) continue
                val addrs = intf.inetAddresses
                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (addr is Inet4Address && !addr.isLoopbackAddress) {
                        return addr.hostAddress
                    }
                }
            }
            null
        } catch (_: Exception) {
            null
        }
    }

    private fun formatIpv4(ip: Int): String {
        return String.format(
            "%d.%d.%d.%d",
            ip and 0xff,
            ip shr 8 and 0xff,
            ip shr 16 and 0xff,
            ip shr 24 and 0xff
        )
    }
}