"""Resume ami-manifest.json (formato de Packer) en ami-ids.json: la última AMI de cada rol.

Uso: python scripts/ami_ids.py ami-manifest.json ami-ids.json

Salida, lista para el IaC y para la API de la plataforma:
{
  "region": "us-east-2",
  "image_version": "0.1.0",
  "git_commit": "abc1234",
  "ami": {"frontend": "ami-...", "backend": "ami-...", "db": "ami-...", "monitoring": "ami-..."}
}
"""
import json
import sys


def main(manifest_path: str, output_path: str) -> None:
    with open(manifest_path, encoding="utf-8") as fh:
        builds = json.load(fh)["builds"]

    latest = {}
    for build in sorted(builds, key=lambda b: b["build_time"]):
        # artifact_id = "us-east-2:ami-0123..."; con varias regiones vienen separadas por coma.
        region, ami = build["artifact_id"].split(",")[0].split(":")
        latest[build["name"]] = {"region": region, "ami": ami, "build_time": build["build_time"],
                                 **build.get("custom_data", {})}

    if not latest:
        sys.exit("El manifest no tiene builds.")

    newest = max(latest.values(), key=lambda b: b["build_time"])
    result = {
        "region": newest["region"],
        "image_version": newest.get("image_version"),
        "git_commit": newest.get("git_commit"),
        "ami": {role: data["ami"] for role, data in sorted(latest.items())},
    }
    with open(output_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=2)
        fh.write("\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
