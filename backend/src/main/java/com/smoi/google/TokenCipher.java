package com.smoi.google;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

import org.springframework.stereotype.Component;

/**
 * Encrypts Google refresh tokens at rest with AES-256-GCM (NFR-03.03).
 *
 * <ul>
 *   <li>A fresh random 12-byte IV for every encryption, stored in front of the ciphertext.
 *       GCM must never reuse an IV with the same key.</li>
 *   <li>The user id is the associated data: the tag covers it, so a token copied into another
 *       user's row fails to decrypt instead of quietly working for them.</li>
 *   <li>The 128-bit tag means a tampered ciphertext fails to decrypt rather than giving garbage.</li>
 * </ul>
 * The key comes from GOOGLE_TOKEN_KEY and is read when first needed, so SMOI starts without it.
 */
@Component
public class TokenCipher {

    public static final int KEY_VERSION = 1;
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;

    private final GoogleProperties props;
    private final SecureRandom random = new SecureRandom();

    public TokenCipher(GoogleProperties props) {
        this.props = props;
    }

    public byte[] encrypt(UUID userId, String plaintext) {
        try {
            byte[] iv = new byte[IV_BYTES];
            random.nextBytes(iv);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, iv));
            c.updateAAD(aad(userId));
            byte[] ct = c.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            return ByteBuffer.allocate(iv.length + ct.length).put(iv).put(ct).array();
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("Token encryption failed", e);
        }
    }

    /** @throws IllegalStateException if the data was tampered with, belongs to another user, or the key changed */
    public String decrypt(UUID userId, byte[] stored) {
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, stored, 0, IV_BYTES));
            c.updateAAD(aad(userId));
            return new String(c.doFinal(stored, IV_BYTES, stored.length - IV_BYTES), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException e) {
            // No detail: the message must not help anyone probing the ciphertext.
            throw new IllegalStateException("Stored Google token could not be decrypted");
        }
    }

    private SecretKeySpec key() {
        return new SecretKeySpec(props.keyBytes(), "AES");
    }

    private static byte[] aad(UUID userId) {
        return userId.toString().getBytes(StandardCharsets.US_ASCII);
    }
}
