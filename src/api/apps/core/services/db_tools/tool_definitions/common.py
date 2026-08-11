def prop(kind, description, **extra):
    data = {"type": kind, "description": description}
    data.update(extra)
    return data


def tool_spec(name, description, properties, required=None):
    schema = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return {"toolSpec": {"name": name, "description": description, "inputSchema": {"json": schema}}}
