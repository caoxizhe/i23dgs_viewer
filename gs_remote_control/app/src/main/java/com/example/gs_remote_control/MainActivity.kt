package com.example.gs_remote_control

import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Bundle
import android.util.Log
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import fi.iki.elonen.NanoHTTPD
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import java.net.InetSocketAddress
import java.util.Locale
import java.util.concurrent.CopyOnWriteArraySet

class MainActivity : AppCompatActivity(), SensorEventListener {
    private var httpServer: InviteHttpServer? = null
    private var wsServer: SimpleWSServer? = null

    private lateinit var statusView: TextView
    private lateinit var displacementView: TextView
    private lateinit var clientsView: TextView

    private lateinit var sensorManager: SensorManager
    private var accelSensor: Sensor? = null
    private var gyroSensor: Sensor? = null

    // orientation fusion (gyro prediction + accelerometer correction)
    // quaternion body->world
    private var qw = 1f
    private var qx = 0f
    private var qy = 0f
    private var qz = 0f
    private var hasOrientation = false
    private var lastGyroTsNs = 0L
    private val latestAccel = FloatArray(3)
    private var hasAccel = false
    private val integralErr = FloatArray(3)
    private val fusionKp = 1.8f
    private val fusionKi = 0.03f

    private val displacement = FloatArray(3) // x-east, y-north, z-up(world)
    private val velocity = FloatArray(3)
    private val accBias = FloatArray(3)
    private var lastAccelTsNs = 0L
    private var lastBroadcastMs = 0L
    private var lastGyroNorm = 0f
    private var stationarySinceNs = 0L
    private var isStationary = false
    private var streamStartNs = 0L

    // short-window drift suppression:
    // if a window displacement is very small, treat as stationary and ignore it.
    private var windowStartNs = 0L
    private var windowDispAccum = 0f
    private val windowStep = FloatArray(3)
    private val stationaryWindowNs = 400_000_000L // 0.4s
    private val stationaryDispThreshold = 0.020f // 2cm
    private val accelDeadband = 0.05f
    private val gyroQuietThreshold = 0.06f // rad/s
    private val accQuietThreshold = 0.12f // m/s^2
    private val speedQuietThreshold = 0.03f // m/s
    private val motionSensitivity = 0.45f
    private val minEffectiveStep = 0.0012f // 1.2mm per sample
    private val zuptHoldNs = 550_000_000L // 0.55s
    private val biasWarmupNs = 180_000_000L // 0.18s
    private val startupSettleNs = 1_200_000_000L // 1.2s
    private val biasAlpha = 0.035f
    private val broadcastIntervalMs = 50L // 20Hz
    private val gravity = 9.80665f

    private var originSeq = 0

    private val tag = "GsRemoteControl"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusView = findViewById(R.id.status)
        displacementView = findViewById(R.id.displacement)
        clientsView = findViewById(R.id.clients)
        val ipView = findViewById<TextView>(R.id.ip)
        val startBtn = findViewById<Button>(R.id.startBtn)
        val stopBtn = findViewById<Button>(R.id.stopBtn)
        val resetBtn = findViewById<Button>(R.id.resetBtn)

        sensorManager = getSystemService(SENSOR_SERVICE) as SensorManager
        accelSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        gyroSensor = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)

        val ip = NetworkUtils.getLocalIpAddress(this) ?: "0.0.0.0"
        ipView.text = "IP: $ip"
        displacementView.text = "位移(m): x=0.000 y=0.000 z=0.000"
        clientsView.text = "连接数: 0"

        httpServer = InviteHttpServer(8765) { onInviteReceived() }
        try {
            httpServer?.start()
            statusView.text = "HTTP invite running :8765 | 等待启动"
        } catch (e: Exception) {
            statusView.text = "Failed to start HTTP server: ${e.message}"
            Log.e(tag, "http start", e)
        }

        startBtn.setOnClickListener {
            startStreaming()
        }
        stopBtn.setOnClickListener {
            stopStreaming()
        }
        resetBtn.setOnClickListener {
            resetTracking(true)
        }
    }

    private fun onInviteReceived() {
        runOnUiThread {
            AlertDialog.Builder(this)
                .setTitle("Connection request")
                .setMessage("A remote viewer requests connection. Start IMU streaming?")
                .setPositiveButton("Start") { _, _ -> startStreaming() }
                .setNegativeButton("Reject", null)
                .show()
        }
    }

    private fun startStreaming() {
        if (wsServer != null) return

        wsServer = SimpleWSServer(
            port = 8766,
            onClientCountChanged = { count ->
                runOnUiThread { clientsView.text = "连接数: $count" }
            },
            onMessage = { msg -> handleClientMessage(msg) }
        )

        wsServer?.start()
        resetTracking(false)
        streamStartNs = System.nanoTime()
        registerSensors()
        statusView.text = "WebSocket :8766 | IMU 采集中"
    }

    private fun stopStreaming() {
        unregisterSensors()
        wsServer?.stop()
        wsServer = null
        clientsView.text = "连接数: 0"
        statusView.text = "WebSocket stopped | 已停止"
    }

    private fun registerSensors() {
        val acc = accelSensor
        val gyro = gyroSensor
        if (acc == null || gyro == null) {
            statusView.text = "IMU sensor not available"
            return
        }

        sensorManager.registerListener(this, gyro, SensorManager.SENSOR_DELAY_GAME)
        sensorManager.registerListener(this, acc, SensorManager.SENSOR_DELAY_GAME)
    }

    private fun unregisterSensors() {
        sensorManager.unregisterListener(this)
    }

    private fun normalizeQuat() {
        val n = kotlin.math.sqrt(qw * qw + qx * qx + qy * qy + qz * qz)
        if (n > 1e-9f) {
            val inv = 1f / n
            qw *= inv
            qx *= inv
            qy *= inv
            qz *= inv
        } else {
            qw = 1f
            qx = 0f
            qy = 0f
            qz = 0f
        }
    }

    // gravity direction in device frame from current quaternion
    private fun gravityBody(out: FloatArray) {
        out[0] = 2f * (qx * qz - qw * qy)
        out[1] = 2f * (qw * qx + qy * qz)
        out[2] = qw * qw - qx * qx - qy * qy + qz * qz
    }

    private fun rotateBodyToWorld(vx: Float, vy: Float, vz: Float, out: FloatArray) {
        val xx = qx * qx
        val yy = qy * qy
        val zz = qz * qz
        val xy = qx * qy
        val xz = qx * qz
        val yz = qy * qz
        val wx = qw * qx
        val wy = qw * qy
        val wz = qw * qz

        val r00 = 1f - 2f * (yy + zz)
        val r01 = 2f * (xy - wz)
        val r02 = 2f * (xz + wy)
        val r10 = 2f * (xy + wz)
        val r11 = 1f - 2f * (xx + zz)
        val r12 = 2f * (yz - wx)
        val r20 = 2f * (xz - wy)
        val r21 = 2f * (yz + wx)
        val r22 = 1f - 2f * (xx + yy)

        out[0] = r00 * vx + r01 * vy + r02 * vz
        out[1] = r10 * vx + r11 * vy + r12 * vz
        out[2] = r20 * vx + r21 * vy + r22 * vz
    }

    private fun fuseGyro(dt: Float, gxRaw: Float, gyRaw: Float, gzRaw: Float) {
        var gx = gxRaw
        var gy = gyRaw
        var gz = gzRaw

        if (hasAccel) {
            var ax = latestAccel[0]
            var ay = latestAccel[1]
            var az = latestAccel[2]
            val an = kotlin.math.sqrt(ax * ax + ay * ay + az * az)
            if (an > 1e-6f) {
                ax /= an
                ay /= an
                az /= an

                val gBody = FloatArray(3)
                gravityBody(gBody)
                val gxEst = gBody[0]
                val gyEst = gBody[1]
                val gzEst = gBody[2]

                // error = a_meas x g_est
                val ex = ay * gzEst - az * gyEst
                val ey = az * gxEst - ax * gzEst
                val ez = ax * gyEst - ay * gxEst

                integralErr[0] += ex * dt
                integralErr[1] += ey * dt
                integralErr[2] += ez * dt

                gx += fusionKp * ex + fusionKi * integralErr[0]
                gy += fusionKp * ey + fusionKi * integralErr[1]
                gz += fusionKp * ez + fusionKi * integralErr[2]
            }
        }

        val halfDt = 0.5f * dt
        val nqW = qw + (-qx * gx - qy * gy - qz * gz) * halfDt
        val nqX = qx + (qw * gx + qy * gz - qz * gy) * halfDt
        val nqY = qy + (qw * gy - qx * gz + qz * gx) * halfDt
        val nqZ = qz + (qw * gz + qx * gy - qy * gx) * halfDt

        qw = nqW
        qx = nqX
        qy = nqY
        qz = nqZ
        normalizeQuat()
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (event.sensor.type == Sensor.TYPE_ACCELEROMETER) {
            latestAccel[0] = event.values[0]
            latestAccel[1] = event.values[1]
            latestAccel[2] = event.values[2]
            hasAccel = true

            if (!hasOrientation) {
                return
            }

            if (lastAccelTsNs == 0L) {
                lastAccelTsNs = event.timestamp
                windowStartNs = event.timestamp
                return
            }

            val dt = ((event.timestamp - lastAccelTsNs).coerceAtLeast(0L) / 1_000_000_000.0f)
            lastAccelTsNs = event.timestamp
            if (dt <= 0f || dt > 0.1f) return

            val gBody = FloatArray(3)
            gravityBody(gBody)

            // linear acceleration in body frame = measured accel - estimated gravity
            val lax = latestAccel[0] - gBody[0] * gravity
            val lay = latestAccel[1] - gBody[1] * gravity
            val laz = latestAccel[2] - gBody[2] * gravity

            // rotate to world frame
            val world = FloatArray(3)
            rotateBodyToWorld(lax, lay, laz, world)

            val wxRaw = world[0]
            val wyRaw = world[1]
            val wzRaw = world[2]

            // online bias correction
            var wx = wxRaw - accBias[0]
            var wy = wyRaw - accBias[1]
            var wz = wzRaw - accBias[2]

            // deadband around zero acceleration
            if (kotlin.math.abs(wx) < accelDeadband) wx = 0f
            if (kotlin.math.abs(wy) < accelDeadband) wy = 0f
            if (kotlin.math.abs(wz) < accelDeadband) wz = 0f

            // lower overall sensitivity to tiny inertial changes
            wx *= motionSensitivity
            wy *= motionSensitivity
            wz *= motionSensitivity

            val accNorm = kotlin.math.sqrt(wx * wx + wy * wy + wz * wz)
            val speedNorm = kotlin.math.sqrt(
                velocity[0] * velocity[0] + velocity[1] * velocity[1] + velocity[2] * velocity[2]
            )

            val stationaryCandidate =
                lastGyroNorm < gyroQuietThreshold &&
                    accNorm < accQuietThreshold &&
                    speedNorm < speedQuietThreshold

            if (stationaryCandidate) {
                if (stationarySinceNs == 0L) stationarySinceNs = event.timestamp
                val holdNs = event.timestamp - stationarySinceNs

                // adapt bias only during stable stationary window
                if (holdNs >= biasWarmupNs) {
                    accBias[0] = (1f - biasAlpha) * accBias[0] + biasAlpha * wxRaw
                    accBias[1] = (1f - biasAlpha) * accBias[1] + biasAlpha * wyRaw
                    accBias[2] = (1f - biasAlpha) * accBias[2] + biasAlpha * wzRaw
                }

                if (holdNs >= zuptHoldNs) {
                    // ZUPT hard lock
                    velocity[0] = 0f
                    velocity[1] = 0f
                    velocity[2] = 0f
                    windowStep[0] = 0f
                    windowStep[1] = 0f
                    windowStep[2] = 0f
                    windowDispAccum = 0f
                    windowStartNs = event.timestamp
                    isStationary = true
                }
            } else {
                stationarySinceNs = 0L
                isStationary = false
            }

            // initial settling: estimate bias without accumulating displacement
            if (event.timestamp - streamStartNs < startupSettleNs) {
                velocity[0] = 0f
                velocity[1] = 0f
                velocity[2] = 0f
                val now = System.currentTimeMillis()
                if (now - lastBroadcastMs >= broadcastIntervalMs) {
                    lastBroadcastMs = now
                    wsServer?.broadcastJson(buildPayload(now))
                    runOnUiThread {
                        statusView.text = "WebSocket :8766 | IMU 初始化中"
                        renderDisplacement()
                    }
                }
                return
            }

            if (isStationary) {
                val now = System.currentTimeMillis()
                if (now - lastBroadcastMs >= broadcastIntervalMs) {
                    lastBroadcastMs = now
                    wsServer?.broadcastJson(buildPayload(now))
                    runOnUiThread {
                        statusView.text = "WebSocket :8766 | IMU 静止锁定"
                        renderDisplacement()
                    }
                }
                return
            }

            // integrate velocity
            velocity[0] += wx * dt
            velocity[1] += wy * dt
            velocity[2] += wz * dt

            // light velocity damping for long-tail drift
            velocity[0] *= 0.9975f
            velocity[1] *= 0.9975f
            velocity[2] *= 0.9975f

            // integrate displacement increment for this sample
            var stepX = velocity[0] * dt
            var stepY = velocity[1] * dt
            var stepZ = velocity[2] * dt
            var stepNorm = kotlin.math.sqrt(stepX * stepX + stepY * stepY + stepZ * stepZ)

            if (stepNorm < minEffectiveStep) {
                stepX = 0f
                stepY = 0f
                stepZ = 0f
                stepNorm = 0f
                velocity[0] *= 0.9f
                velocity[1] *= 0.9f
                velocity[2] *= 0.9f
            }

            // accumulate within a short window, then decide move vs stationary
            windowStep[0] += stepX
            windowStep[1] += stepY
            windowStep[2] += stepZ
            windowDispAccum += stepNorm

            if (event.timestamp - windowStartNs >= stationaryWindowNs) {
                if (windowDispAccum < stationaryDispThreshold) {
                    // small motion window -> treat as stationary, ignore drift
                    velocity[0] = 0f
                    velocity[1] = 0f
                    velocity[2] = 0f
                    isStationary = true
                } else {
                    displacement[0] += windowStep[0]
                    displacement[1] += windowStep[1]
                    displacement[2] += windowStep[2]
                    isStationary = false
                }

                windowStep[0] = 0f
                windowStep[1] = 0f
                windowStep[2] = 0f
                windowDispAccum = 0f
                windowStartNs = event.timestamp
            }

            val now = System.currentTimeMillis()
            if (now - lastBroadcastMs >= broadcastIntervalMs) {
                lastBroadcastMs = now
                wsServer?.broadcastJson(buildPayload(now))
                runOnUiThread {
                    statusView.text = "WebSocket :8766 | IMU 采集中"
                    renderDisplacement()
                }
            }
            return
        }

        if (event.sensor.type == Sensor.TYPE_GYROSCOPE) {
            val gx = event.values[0]
            val gy = event.values[1]
            val gz = event.values[2]
            lastGyroNorm = kotlin.math.sqrt(gx * gx + gy * gy + gz * gz)

            if (lastGyroTsNs == 0L) {
                lastGyroTsNs = event.timestamp
                return
            }
            val dt = ((event.timestamp - lastGyroTsNs).coerceAtLeast(0L) / 1_000_000_000.0f)
            lastGyroTsNs = event.timestamp
            if (dt <= 0f || dt > 0.1f) return

            fuseGyro(dt, gx, gy, gz)
            hasOrientation = true
            return
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
        // no-op
    }

    private fun resetTracking(broadcast: Boolean) {
        qw = 1f
        qx = 0f
        qy = 0f
        qz = 0f
        hasOrientation = false
        hasAccel = false
        lastGyroTsNs = 0L
        lastAccelTsNs = 0L
        lastBroadcastMs = 0L
        windowStartNs = 0L
        windowDispAccum = 0f
        windowStep[0] = 0f
        windowStep[1] = 0f
        windowStep[2] = 0f
        accBias[0] = 0f
        accBias[1] = 0f
        accBias[2] = 0f
        lastGyroNorm = 0f
        stationarySinceNs = 0L
        isStationary = false
        streamStartNs = 0L
        displacement.fill(0f)
        velocity.fill(0f)
        originSeq += 1
        renderDisplacement()

        if (broadcast) {
            wsServer?.broadcastJson(
                "{\"type\":\"reset\",\"origin\":$originSeq,\"ts\":${System.currentTimeMillis()}}"
            )
        }
    }

    private fun renderDisplacement() {
        displacementView.text = String.format(
            Locale.US,
            "位移(m): x=%.3f y=%.3f z=%.3f",
            displacement[0],
            displacement[1],
            displacement[2]
        )
    }

    private fun buildPayload(ts: Long): String {
        val speed = kotlin.math.sqrt(
            velocity[0] * velocity[0] + velocity[1] * velocity[1] + velocity[2] * velocity[2]
        )

        return String.format(
            Locale.US,
            "{\"type\":\"relative_displacement\",\"dx\":%.6f,\"dy\":%.6f,\"dz\":%.6f,\"vx\":%.6f,\"vy\":%.6f,\"vz\":%.6f,\"speed\":%.6f,\"origin\":%d,\"ts\":%d}",
            displacement[0],
            displacement[1],
            displacement[2],
            velocity[0],
            velocity[1],
            velocity[2],
            speed,
            originSeq,
            ts
        )
    }

    private fun handleClientMessage(message: String) {
        if (message.contains("\"type\":\"reset\"")) {
            runOnUiThread { resetTracking(false) }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        httpServer?.stop()
        wsServer?.stop()
        unregisterSensors()
    }
}

// Simple HTTP server that listens for POST /invite and calls a handler
class InviteHttpServer(port: Int, private val onInvite: () -> Unit) : NanoHTTPD(port) {
    override fun serve(session: IHTTPSession): Response {
        if (session.method == Method.POST && session.uri == "/invite") {
            val map = HashMap<String, String>()
            session.parseBody(map)
            onInvite()
            return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}")
        }
        return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "not found")
    }
}

// Very small WebSocket server that can broadcast JSON strings
class SimpleWSServer(
    port: Int,
    private val onClientCountChanged: (Int) -> Unit,
    private val onMessage: (String) -> Unit
) : WebSocketServer(InetSocketAddress(port)) {
    private val clients = CopyOnWriteArraySet<WebSocket>()

    override fun onOpen(conn: WebSocket, handshake: ClientHandshake) {
        clients.add(conn)
        onClientCountChanged(clients.size)
        conn.send("{\"type\":\"hello\",\"protocol\":1}")
    }

    override fun onClose(conn: WebSocket, code: Int, reason: String?, remote: Boolean) {
        clients.remove(conn)
        onClientCountChanged(clients.size)
    }

    override fun onMessage(conn: WebSocket, message: String?) {
        if (message != null) onMessage(message)
    }

    override fun onError(conn: WebSocket?, ex: Exception?) {}

    override fun onStart() {}

    fun broadcastJson(msg: String) {
        for (c in clients) {
            if (c.isOpen) c.send(msg)
        }
    }
}