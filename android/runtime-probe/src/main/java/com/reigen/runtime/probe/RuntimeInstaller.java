package com.reigen.runtime.probe;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.res.AssetManager;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import java.io.File;
import java.io.FileInputStream;
import java.io.InterruptedIOException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.zip.GZIPInputStream;

public final class RuntimeInstaller {
    private static final String ASSET_ROOT = "runtime/";
    private static final int MAX_ARCHIVE_ENTRIES = 300_000;
    private static final long MAX_UNCOMPRESSED_BYTES = 4L * 1024 * 1024 * 1024;

    private RuntimeInstaller() {}

    public static Runtime install(Context context, Consumer<String> status) throws Exception {
        File base = new File(context.getFilesDir(), "runtime-probe");
        File rootfs = new File(base, "rootfs");
        File marker = new File(rootfs, ".reigen-runtime-version");
        File temp = new File(base, "tmp");
        File reports = new File(base, "reports");
        if (!base.mkdirs() && !base.isDirectory()) throw new IOException("Cannot create runtime directory");
        if (!temp.mkdirs() && !temp.isDirectory()) throw new IOException("Cannot create runtime temp directory");
        if (!reports.mkdirs() && !reports.isDirectory()) throw new IOException("Cannot create report directory");
        cleanup(new File(base, "rootfs.staging"), status);
        File previous = new File(base, "rootfs.previous");
        if (!rootfs.exists() && previous.exists() && !previous.renameTo(rootfs)) {
            throw new IOException("Cannot recover previous runtime");
        }
        if (rootfs.exists()) cleanup(previous, status);
        cleanup(new File(base, "rootfs.download"), status);
        cleanup(new File(base, "omp.download"), status);

        Manifest manifest = readManifest(context.getAssets());
        verifyNativeLibraries(context.getApplicationInfo(), manifest);
        if (!marker.isFile() || !manifest.version.equals(readUtf8(marker))) {
            installRootfs(context, base, rootfs, manifest, status);
        }
        writeDnsConfiguration(context, rootfs.toPath());
        return new Runtime(
                rootfs.toPath(),
                temp.toPath(),
                reports.toPath(),
                new File(context.getApplicationInfo().nativeLibraryDir, "libproot.so").toPath(),
                new File(context.getApplicationInfo().nativeLibraryDir, "libproot-loader.so").toPath(),
                new File(context.getApplicationInfo().nativeLibraryDir, "libproot-loader32.so").toPath(),
                manifest.version);
    }

    private static void installRootfs(
            Context context,
            File base,
            File rootfs,
            Manifest manifest,
            Consumer<String> status) throws Exception {
        File archive = new File(base, "rootfs.download");
        File omp = new File(base, "omp.download");
        File staging = new File(base, "rootfs.staging");
        File previous = new File(base, "rootfs.previous");
        deleteRecursively(staging);
        deleteRecursively(previous);
        if (!staging.mkdirs()) throw new IOException("Cannot create staging rootfs");
        try {
            status.accept("Verifying pinned Debian rootfs…");
            copyAsset(context.getAssets(), manifest.rootfsAsset, archive);
            ArtifactVerifier.verifySha256(archive.toPath(), manifest.rootfsSha256);
            status.accept("Verifying pinned OMP binary…");
            copyAsset(context.getAssets(), manifest.ompAsset, omp);
            ArtifactVerifier.verifySha256(omp.toPath(), manifest.ompSha256);
            status.accept("Extracting Debian rootfs…");
            try (InputStream compressed = new FileInputStream(archive);
                    InputStream gzip = new GZIPInputStream(compressed)) {
                SafeTarExtractor.extract(gzip, staging.toPath(), MAX_ARCHIVE_ENTRIES, MAX_UNCOMPRESSED_BYTES);
            }
            Path ompTarget = staging.toPath().resolve("usr/local/bin/omp");
            Files.createDirectories(ompTarget.getParent());
            Files.copy(omp.toPath(), ompTarget, StandardCopyOption.REPLACE_EXISTING);
            if (!ompTarget.toFile().setExecutable(true, true)) {
                throw new IOException("Cannot make OMP executable");
            }
            Files.write(
                    staging.toPath().resolve(".reigen-runtime-version"),
                    manifest.version.getBytes(StandardCharsets.UTF_8));
            if (rootfs.exists() && !rootfs.renameTo(previous)) {
                throw new IOException("Cannot preserve previous runtime");
            }
            if (!staging.renameTo(rootfs)) {
                boolean restored = !previous.exists() || previous.renameTo(rootfs);
                throw new IOException(restored
                        ? "Cannot activate verified runtime; previous runtime restored"
                        : "Cannot activate verified runtime and rollback failed");
            }
            cleanup(previous, status);
        } finally {
            cleanup(staging, status);
            cleanup(archive, status);
            cleanup(omp, status);
        }
    }

    private static void cleanup(File file, Consumer<String> status) {
        try {
            deleteRecursively(file);
        } catch (IOException error) {
            status.accept("Cleanup warning for " + file.getName() + ": " + error.getMessage());
        }
    }

    private static void writeDnsConfiguration(Context context, Path rootfs) throws IOException {
        List<String> addresses = new ArrayList<>();
        ConnectivityManager connectivity = context.getSystemService(ConnectivityManager.class);
        if (connectivity != null) {
            LinkProperties properties = connectivity.getLinkProperties(connectivity.getActiveNetwork());
            if (properties != null) {
                for (InetAddress address : properties.getDnsServers()) {
                    addresses.add("nameserver " + address.getHostAddress());
                }
            }
        }
        if (addresses.isEmpty()) {
            addresses.add("nameserver 1.1.1.1");
            addresses.add("nameserver 8.8.8.8");
        }
        Path etc = rootfs.resolve("etc");
        if (Files.isSymbolicLink(etc)) throw new IOException("Runtime /etc cannot be a symlink");
        Files.createDirectories(etc);
        Path resolv = etc.resolve("resolv.conf");
        Files.deleteIfExists(resolv);
        Files.write(resolv, String.join("\n", addresses).concat("\n").getBytes(StandardCharsets.UTF_8));
    }

    private static void verifyNativeLibraries(ApplicationInfo info, Manifest manifest) throws IOException {
        Path nativeDir = new File(info.nativeLibraryDir).toPath();
        ArtifactVerifier.verifySha256(nativeDir.resolve("libproot.so"), manifest.prootSha256);
        ArtifactVerifier.verifySha256(nativeDir.resolve("libproot-loader.so"), manifest.loaderSha256);
        ArtifactVerifier.verifySha256(nativeDir.resolve("libproot-loader32.so"), manifest.loader32Sha256);
    }

    private static Manifest readManifest(AssetManager assets) throws IOException, JSONException {
        try (InputStream stream = assets.open(ASSET_ROOT + "manifest.json")) {
            byte[] bytes = readAll(stream);
            JSONObject json = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            if (json.getInt("schemaVersion") != 1) {
                throw new JSONException("Unsupported runtime manifest schema");
            }
            JSONObject rootfs = json.getJSONObject("rootfs");
            JSONObject proot = json.getJSONObject("proot");
            JSONObject omp = json.getJSONObject("omp");
            return new Manifest(
                    json.getString("version"),
                    rootfs.getString("asset"), rootfs.getString("sha256"),
                    proot.getString("sha256"), proot.getString("loaderSha256"), proot.getString("loader32Sha256"),
                    omp.getString("asset"), omp.getString("sha256"));
        }
    }

    private static void copyAsset(AssetManager assets, String path, File destination) throws IOException {
        try (InputStream source = assets.open(ASSET_ROOT + path);
                FileOutputStream output = new FileOutputStream(destination)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = source.read(buffer)) >= 0) {
                if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Asset copy cancelled");
                output.write(buffer, 0, read);
            }
        }
    }

    private static byte[] readAll(InputStream source) throws IOException {
        java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = source.read(buffer)) >= 0) output.write(buffer, 0, read);
        return output.toByteArray();
    }

    private static String readUtf8(File file) throws IOException {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8).trim();
    }

    private static void deleteRecursively(File file) throws IOException {
        Path path = file.toPath();
        if (!Files.exists(path, java.nio.file.LinkOption.NOFOLLOW_LINKS)) return;
        if (Files.isDirectory(path, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            try (java.nio.file.DirectoryStream<Path> children = Files.newDirectoryStream(path)) {
                for (Path child : children) deleteRecursively(child.toFile());
            }
        }
        Files.deleteIfExists(path);
    }

    public static final class Runtime {
        public final Path rootfs;
        public final Path temp;
        public final Path reports;
        public final Path proot;
        public final Path loader;
        public final Path loader32;
        public final String version;

        private Runtime(Path rootfs, Path temp, Path reports, Path proot, Path loader, Path loader32, String version) {
            this.rootfs = rootfs;
            this.temp = temp;
            this.reports = reports;
            this.proot = proot;
            this.loader = loader;
            this.loader32 = loader32;
            this.version = version;
        }
    }

    private static final class Manifest {
        private final String version;
        private final String rootfsAsset;
        private final String rootfsSha256;
        private final String prootSha256;
        private final String loaderSha256;
        private final String loader32Sha256;
        private final String ompAsset;
        private final String ompSha256;

        private Manifest(String version, String rootfsAsset, String rootfsSha256, String prootSha256,
                String loaderSha256, String loader32Sha256, String ompAsset, String ompSha256) {
            this.version = version;
            this.rootfsAsset = rootfsAsset;
            this.rootfsSha256 = rootfsSha256;
            this.prootSha256 = prootSha256;
            this.loaderSha256 = loaderSha256;
            this.loader32Sha256 = loader32Sha256;
            this.ompAsset = ompAsset;
            this.ompSha256 = ompSha256;
        }
    }
}
