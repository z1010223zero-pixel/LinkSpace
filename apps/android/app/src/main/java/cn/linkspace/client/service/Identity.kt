package cn.linkspace.client.service

import android.util.Log
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder
import java.io.File
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.Date

/**
 * 设备身份证书。
 *
 * 与桌面端同一套模型：每台设备一对自签密钥，首次配对时人工核对指纹（TOFU）。
 * **必须持久化**：每次启动重新生成会让指纹变化，已配对的对端会判定身份变更，
 * 用户就得重新配对。
 *
 * 用 BouncyCastle 生成：Android 未公开「从 Keystore 密钥签发自签证书」的 API，
 * 而系统内置的 BC 是重打包内部类，不能直接依赖。
 */
class Identity(private val dir: File) {

    data class DeviceCert(
        val key: String,
        val cert: String,
        /** 证书 DER 的 SHA-256，冒号分隔小写十六进制，用于人工核对 */
        val fingerprint: String
    )

    private var cached: DeviceCert? = null

    @Synchronized
    fun get(): DeviceCert {
        cached?.let { return it }

        val keyFile = File(dir, "device-key.pem")
        val certFile = File(dir, "device-cert.pem")

        if (keyFile.exists() && certFile.exists()) {
            val cert = DeviceCert(
                key = keyFile.readText(),
                cert = certFile.readText(),
                fingerprint = fingerprintOf(certFile.readText())
            )
            cached = cert
            Log.i(TAG, "已加载设备身份证书，指纹 ${cert.fingerprint.take(23)}…")
            return cert
        }

        val generated = generate()
        dir.mkdirs()
        keyFile.writeText(generated.key)
        certFile.writeText(generated.cert)
        Log.i(TAG, "已生成设备身份证书，指纹 ${generated.fingerprint.take(23)}…")
        cached = generated
        return generated
    }

    /** 供 SSL 上下文使用的 KeyStore（PKCS12） */
    fun keyStore(): KeyStore {
        val cert = get()
        val ks = KeyStore.getInstance("PKCS12")
        ks.load(null, null)
        ks.setKeyEntry(
            "linkspace",
            PemUtils.loadPrivateKey(cert.key),
            CharArray(0),
            arrayOf<X509Certificate>(PemUtils.loadCertificate(cert.cert))
        )
        return ks
    }

    private fun generate(): DeviceCert {
        // 不要显式 setProvider("BC")：Android 系统里已经有一个名为 BC 的
        // provider（重打包的 BouncyCastle），新加的抢不走这个名字，
        // 按名字查找会落到系统那个上，报 no such algorithm。
        // 不指定 provider，让 JCE 按优先级自己找，Conscrypt 与 BC 都能签。
        val kp = KeyPairGenerator.getInstance("RSA").apply {
            initialize(2048, SecureRandom())
        }.generateKeyPair()

        val notBefore = Date(System.currentTimeMillis() - 86_400_000L)
        val notAfter = Date(System.currentTimeMillis() + 10L * 365 * 86_400_000L)

        val holder = JcaX509v3CertificateBuilder(
            X500Name("CN=LinkSpace Device"),
            BigInteger(System.currentTimeMillis().toString()),
            notBefore,
            notAfter,
            X500Name("CN=LinkSpace Device"),
            kp.public
        )

        val signer = JcaContentSignerBuilder("SHA256withRSA").build(kp.private)
        val x509 = JcaX509CertificateConverter().getCertificate(holder.build(signer))

        val certPem = PemUtils.toPem("CERTIFICATE", x509.encoded)
        val keyPem = PemUtils.toPem("PRIVATE KEY", kp.private.encoded)
        return DeviceCert(key = keyPem, cert = certPem, fingerprint = fingerprintOf(certPem))
    }

    companion object {
        private const val TAG = "LinkSpace/Identity"

        /** 与 `openssl x509 -fingerprint -sha256` 及桌面端算法一致 */
        fun fingerprintOf(certPem: String): String {
            val body = certPem
                .replace("-----BEGIN CERTIFICATE-----", "")
                .replace("-----END CERTIFICATE-----", "")
                .replace("\\s".toRegex(), "")
            val der = android.util.Base64.decode(body, android.util.Base64.DEFAULT)
            val digest = java.security.MessageDigest.getInstance("SHA-256").digest(der)
            return digest.joinToString(":") { "%02x".format(it) }
        }
    }
}

/** PEM 编解码。避免为一个工具类引入整个 BC 的高层 API。 */
object PemUtils {

    fun toPem(type: String, der: ByteArray): String {
        val b64 = android.util.Base64.encodeToString(der, android.util.Base64.NO_WRAP)
        return buildString {
            append("-----BEGIN $type-----\n")
            var i = 0
            while (i < b64.length) {
                append(b64, i, minOf(i + 64, b64.length))
                append('\n')
                i += 64
            }
            append("-----END $type-----\n")
        }
    }

    fun loadCertificate(pem: String): X509Certificate {
        val body = pem
            .replace("-----BEGIN CERTIFICATE-----", "")
            .replace("-----END CERTIFICATE-----", "")
            .replace("\\s".toRegex(), "")
        val der = android.util.Base64.decode(body, android.util.Base64.DEFAULT)
        val factory = java.security.cert.CertificateFactory.getInstance("X.509")
        return factory.generateCertificate(der.inputStream()) as X509Certificate
    }

    fun loadPrivateKey(pem: String): java.security.PrivateKey {
        val body = pem
            .replace("-----BEGIN PRIVATE KEY-----", "")
            .replace("-----END PRIVATE KEY-----", "")
            .replace("-----BEGIN RSA PRIVATE KEY-----", "")
            .replace("-----END RSA PRIVATE KEY-----", "")
            .replace("\\s".toRegex(), "")
        val der = android.util.Base64.decode(body, android.util.Base64.DEFAULT)
        val spec = java.security.spec.PKCS8EncodedKeySpec(der)
        return java.security.KeyFactory.getInstance("RSA").generatePrivate(spec)
    }
}
