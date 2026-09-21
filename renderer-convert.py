"""Convert one presentation in a fresh LibreOffice process; called only by renderer.js."""
import os
import pathlib
import resource
import subprocess
import sys
import time
import uuid

import uno
import unohelper
from com.sun.star.task import XInteractionHandler


class AbortInteraction(unohelper.Base, XInteractionHandler):
    def handle(self, request):
        for continuation in request.getContinuations():
            abort = continuation.queryInterface(uno.getTypeByName("com.sun.star.task.XInteractionAbort"))
            if abort is not None:
                abort.select()
                return


def property_value(name, value):
    item = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
    item.Name, item.Value = name, value
    return item


def main():
    input_path, output_path, profile_path = map(pathlib.Path, sys.argv[1:])
    # Bound every individual file the native converter can create.
    resource.setrlimit(resource.RLIMIT_FSIZE, (100 * 1024 * 1024, 100 * 1024 * 1024))
    profile_path.mkdir(mode=0o700)
    user = profile_path / "user"
    user.mkdir(mode=0o700)
    (user / "registrymodifications.xcu").write_text('''<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
</oor:items>''', encoding="utf-8")
    pipe = "harbor_" + uuid.uuid4().hex
    office = subprocess.Popen([
        "/usr/bin/libreoffice", "--headless", "--nologo", "--nodefault", "--norestore", "--nolockcheck",
        "-env:UserInstallation=" + profile_path.as_uri(),
        "--accept=pipe,name=" + pipe + ";urp;StarOffice.ServiceManager",
    ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    document = None
    try:
        context = uno.getComponentContext()
        resolver = context.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", context)
        deadline = time.monotonic() + 20
        remote = None
        while time.monotonic() < deadline:
            if office.poll() is not None:
                raise RuntimeError("LibreOffice stopped before conversion")
            try:
                remote = resolver.resolve("uno:pipe,name=" + pipe + ";urp;StarOffice.ComponentContext")
                break
            except Exception:
                time.sleep(0.1)
        if remote is None:
            raise RuntimeError("LibreOffice startup timed out")
        desktop = remote.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", remote)
        document = desktop.loadComponentFromURL(input_path.as_uri(), "_blank", 0, (
            property_value("Hidden", True), property_value("ReadOnly", True),
            property_value("MacroExecutionMode", 0),  # document.MacroExecMode.NEVER_EXECUTE
            property_value("UpdateDocMode", 0),  # document.UpdateDocMode.NO_UPDATE
            property_value("InteractionHandler", AbortInteraction()),
        ))
        if document is None or not document.supportsService("com.sun.star.presentation.PresentationDocument"):
            raise RuntimeError("Not a readable presentation")
        if document.getDrawPages().getCount() > 500:
            raise RuntimeError("Too many slides for a preview")
        document.storeToURL(output_path.as_uri(), (
            property_value("FilterName", "impress_pdf_Export"), property_value("Overwrite", True),
            property_value("FilterData", uno.Any("[]com.sun.star.beans.PropertyValue", (
                property_value("ExportNotesPages", False), property_value("ExportHiddenSlides", False),
                property_value("ExportFormFields", False), property_value("ExportBookmarks", False),
                property_value("ExportLinksRelativeFsys", False), property_value("IsAddStream", False),
            ))),
        ))
        if not output_path.is_file() or output_path.stat().st_size > 100 * 1024 * 1024:
            raise RuntimeError("Preview output is too large")
    finally:
        if document is not None:
            try:
                document.close(True)
            except Exception:
                pass
        office.terminate()
        try:
            office.wait(timeout=3)
        except subprocess.TimeoutExpired:
            office.kill()
            office.wait()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(1)
