package cn.linkspace.client.service

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class FastStreamDecoderTest {

    @Test
    fun readUint64Le_parsesLittleEndianTimestamp() {
        val raw = byteArrayOf(
            0x01,
            0x78, 0x56, 0x34, 0x12, 0x90.toByte(), 0x01, 0x00, 0x00
        )
        val ts = FastStreamDecoder.readUint64Le(raw, 1)
        assertEquals(0x0000019012345678L, ts)
    }

    @Test
    fun extractSpsPps_extractsFromAudSpsPpsIdr() {
        val au = byteArrayOf(
            // AUD (4-byte start code)
            0, 0, 0, 1, 0x09, 0x10,
            // SPS (4-byte start code, nal_type = 7 -> 0x67)
            0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1f,
            // PPS (3-byte start code, nal_type = 8 -> 0x68)
            0, 0, 1, 0x68, 0xce.toByte(), 0x3c, 0x80.toByte(),
            // IDR (3-byte start code, nal_type = 5 -> 0x65)
            0, 0, 1, 0x65, 0x88.toByte(), 0x84.toByte()
        )
        val csd = FastStreamDecoder.extractSpsPps(au)
        assertNotNull(csd)
        assertArrayEquals(
            byteArrayOf(0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1f),
            csd!!.first
        )
        assertArrayEquals(
            byteArrayOf(0, 0, 0, 1, 0x68, 0xce.toByte(), 0x3c, 0x80.toByte()),
            csd.second
        )
    }

    @Test
    fun extractSpsPps_returnsNullOnPFrame() {
        val pFrameAu = byteArrayOf(
            0, 0, 0, 1, 0x09, 0x30,
            0, 0, 0, 1, 0x41, 0x9a.toByte(), 0x01
        )
        assertNull(FastStreamDecoder.extractSpsPps(pFrameAu))
    }
}
