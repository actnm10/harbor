package com.harborfiles.android;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;

/** Fixed disposable documents for real picker callback and content-resolver tests. */
public final class FixtureDocumentProvider extends ContentProvider {
    static final Uri UPLOAD = Uri.parse("content://com.harborfiles.android.fixture.documents/upload");
    static final Uri DOWNLOAD = Uri.parse("content://com.harborfiles.android.fixture.documents/download");

    @Override public boolean onCreate() { return true; }
    private File file(Uri uri) {
        if (!uri.equals(UPLOAD) && !uri.equals(DOWNLOAD)) throw new IllegalArgumentException("Unknown fixture document");
        return new File(getContext().getFilesDir(), "fixture-" + uri.getLastPathSegment() + ".bin");
    }
    @Override public String getType(Uri uri) { file(uri); return "application/octet-stream"; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File file = file(uri);
        String[] columns = projection == null ? new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE } : projection;
        MatrixCursor cursor = new MatrixCursor(columns); MatrixCursor.RowBuilder row = cursor.newRow();
        for (String column : columns) {
            if (column.equals(OpenableColumns.DISPLAY_NAME)) row.add("fixture.bin");
            else if (column.equals(OpenableColumns.SIZE)) row.add(file.length());
            else row.add(null);
        }
        return cursor;
    }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        return ParcelFileDescriptor.open(file(uri), ParcelFileDescriptor.parseMode(mode));
    }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { return file(uri).delete() ? 1 : 0; }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { throw new UnsupportedOperationException(); }
}
