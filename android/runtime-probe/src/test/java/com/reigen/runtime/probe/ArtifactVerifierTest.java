package com.reigen.runtime.probe;

import static org.junit.Assert.assertThrows;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.Test;

public final class ArtifactVerifierTest {
    @Test
    public void verifiesExactSha256AndRejectsTampering() throws Exception {
        Path file = Files.createTempFile("reigen-artifact", ".bin");
        Files.write(file, "abc".getBytes(StandardCharsets.UTF_8));

        ArtifactVerifier.verifySha256(
                file,
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assertThrows(
                SecurityException.class,
                () -> ArtifactVerifier.verifySha256(file, "0000000000000000000000000000000000000000000000000000000000000000"));
    }
}
