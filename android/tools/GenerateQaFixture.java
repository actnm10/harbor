import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.concurrent.TimeUnit;

/** Java 17+ source launcher. Creates disposable loopback credentials in build output. */
class GenerateQaFixture {
    public static void main(String[] arguments) throws Exception {
        if (arguments.length != 1) throw new IllegalArgumentException("Expected the QA build output directory");
        Path output = Path.of(arguments[0]).toAbsolutePath().normalize();
        if (!output.endsWith(Path.of("build", "generated", "qa-fixture"))) {
            throw new IllegalArgumentException("QA credentials must stay under build/generated/qa-fixture");
        }
        Path assets = output.resolve("assets"), raw = output.resolve("res/raw");
        Files.createDirectories(assets); Files.createDirectories(raw);
        Path scratch = Files.createTempDirectory(output, "keytool-");
        Path storePath = scratch.resolve("loopback.p12"), passwordPath = scratch.resolve("password.txt");
        Path logPath = scratch.resolve("keytool.log");
        byte[] entropy = new byte[24]; new SecureRandom().nextBytes(entropy);
        char[] password = HexFormat.of().formatHex(entropy).toCharArray(); Arrays.fill(entropy, (byte) 0);
        boolean windows = System.getProperty("os.name").toLowerCase().contains("windows");
        Path keytool = Path.of(System.getProperty("java.home"), "bin", windows ? "keytool.exe" : "keytool");
        if (!Files.isRegularFile(keytool)) throw new IllegalStateException("A complete JDK with keytool is required for QA tests");
        try {
            Files.writeString(passwordPath, new String(password), StandardCharsets.UTF_8);
            List<String> command = List.of(keytool.toString(), "-genkeypair", "-noprompt",
                    "-alias", "loopback", "-keyalg", "RSA", "-keysize", "2048", "-sigalg", "SHA256withRSA",
                    "-storetype", "PKCS12", "-keystore", storePath.toString(),
                    "-storepass:file", passwordPath.toString(), "-keypass:file", passwordPath.toString(),
                    "-dname", "CN=Harbor ephemeral loopback QA fixture", "-startdate", "-1d", "-validity", "8",
                    "-ext", "SAN=IP:127.0.0.1", "-ext", "BC:critical=ca:true,pathlen:0",
                    "-ext", "KU:critical=digitalSignature,keyEncipherment,keyCertSign", "-ext", "EKU=serverAuth");
            Process process = new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(logPath.toFile()).start();
            if (!process.waitFor(45, TimeUnit.SECONDS)) {
                process.destroyForcibly(); process.waitFor(5, TimeUnit.SECONDS);
                throw new IllegalStateException("QA certificate generation timed out");
            }
            if (process.exitValue() != 0) throw new IllegalStateException("JDK keytool could not generate the loopback QA certificate");
            KeyStore store = KeyStore.getInstance("PKCS12");
            try (InputStream input = Files.newInputStream(storePath)) { store.load(input, password); }
            PrivateKey key = (PrivateKey) store.getKey("loopback", password);
            Certificate certificate = store.getCertificate("loopback");
            byte[] encodedKey = key.getEncoded();
            try { Files.write(assets.resolve("localhost-key.pk8"), encodedKey); }
            finally { Arrays.fill(encodedKey, (byte) 0); }
            String pem = "-----BEGIN CERTIFICATE-----\n"
                    + Base64.getMimeEncoder(64, new byte[] {'\n'}).encodeToString(certificate.getEncoded())
                    + "\n-----END CERTIFICATE-----\n";
            Files.writeString(assets.resolve("localhost-chain.pem"), pem, StandardCharsets.US_ASCII);
            Files.writeString(raw.resolve("harbor_test_ca.pem"), pem, StandardCharsets.US_ASCII);
            System.out.println("Generated fresh loopback-only QA credentials in build/generated/qa-fixture.");
        } finally {
            Arrays.fill(password, '\0');
            Files.deleteIfExists(storePath); Files.deleteIfExists(passwordPath); Files.deleteIfExists(logPath);
            Files.deleteIfExists(scratch);
        }
    }
}
