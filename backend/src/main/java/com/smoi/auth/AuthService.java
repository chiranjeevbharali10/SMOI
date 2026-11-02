package com.smoi.auth;

import java.util.Locale;
import java.util.Optional;

import com.smoi.user.User;
import com.smoi.user.UserRepository;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

@Service
public class AuthService {

    private final UserRepository users;
    private final PasswordEncoder passwordEncoder;
    private final TokenService tokens;
    /**
     * Hash compared against when the email is unknown, so a login for a missing account
     * takes about as long as one with a wrong password. This stops attackers from finding
     * registered emails by timing the response.
     */
    private final String dummyHash;

    public AuthService(UserRepository users, PasswordEncoder passwordEncoder, TokenService tokens) {
        this.users = users;
        this.passwordEncoder = passwordEncoder;
        this.tokens = tokens;
        this.dummyHash = passwordEncoder.encode("smoi-timing-equalizer");
    }

    public User register(String email, String password) {
        try {
            return users.insert(normalize(email), passwordEncoder.encode(password));
        } catch (DuplicateKeyException e) {
            // Relies on the unique index, so two concurrent registrations cannot both succeed.
            throw new EmailAlreadyRegisteredException();
        }
    }

    /** Returns a token, or empty if the email or password is wrong. The caller cannot tell which. */
    public Optional<TokenService.IssuedToken> login(String email, String password) {
        Optional<User> user = users.findActiveByEmail(normalize(email));
        String hash = user.map(User::passwordHash).orElse(dummyHash);
        boolean matches = passwordEncoder.matches(password, hash);
        if (user.isEmpty() || !matches) {
            return Optional.empty();
        }
        return Optional.of(tokens.issue(user.get()));
    }

    private static String normalize(String email) {
        return email.trim().toLowerCase(Locale.ROOT);
    }

    public static class EmailAlreadyRegisteredException extends RuntimeException {
        public EmailAlreadyRegisteredException() {
            super("Email is already registered");
        }
    }
}
